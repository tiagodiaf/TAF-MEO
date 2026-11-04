// ==UserScript==
// @name         Nemesis VB – Viabilidade
// @namespace    tiago.nemesis.vb
// @version      2.1
// @description  Automatiza o fluxo de viabilidade (ORAP/ORAC): pesquisa, orçamento, recolha e resposta final
// @match        https://nemesis.telecom.pt/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @updateURL    https://raw.githubusercontent.com/tiagodiaf/nemesis-tarefas/main/nemesis-vb.user.js
// @downloadURL  https://raw.githubusercontent.com/tiagodiaf/nemesis-tarefas/main/nemesis-vb.user.js
// ==/UserScript==

(async () => {
  'use strict';

  // ▼ VERSÃO — muda só aqui (e na linha // @version do cabeçalho, que o Tampermonkey não deixa usar variáveis) ▼
  const VERSAO = '2.1';
  if (window.top !== window.self) return;

  /* ───────────── Configuração global (igual para todos) ───────────── */
  const CFG = {
    tarefas: { ORAP: 'PJ0203', ORAC: 'PJ0201' },
    tarefaEsclarecimentos: 'PJ0902',  // Esclarecimentos diversos (substitui a tarefa ORAP/ORAC quando a checkbox está marcada)
    respostaValor: '2569',            // "Projeto elaborado (O)"
    descricaoOrcamento: 'Orçamento',
    obsMax: 200,
    confirmarSel: '#wt24',            // botão "Gravar" do popup de resposta. Se não existir, usa a deteção automática
    abrirTarefasSel: 'img[src*="recolha_tarefas_seleccao_branco.png"]', // o "T" que abre o formulário de tarefas
    timeout: 120000,
    stateKey: 'vb_state_v1',
    base: 'https://nemesis.telecom.pt/',
  };
  const OBS_OPCOES = ['Viável', 'Inviável', 'Viável com adequação', 'Viabilidade Parcial'];
  const PASSOS = [
    'Pesquisar a ordem',
    'Abrir os orçamentos',
    'Criar o orçamento',
    'Submeter a recolha',
    'Responder à ordem',
    'Confirmar a transição',
  ];
  const NEXT = { pesquisa: 'detalhe', detalhe: 'lista', lista: 'recolha', recolha: 'resposta', resposta: 'fim' };
  const PROG = { detalhe: 0, lista: 1, recolha: 3, resposta: 4, fim: 5 };

  /* ───────────── Definições por utilizador (guardadas uma vez) ───────────── */
  const user = () => ({
    brigada: String(GM_getValue('brigada', '') || '').trim(),
    nmec: String(GM_getValue('nmec', '') || '').trim(),
    qtd: String(GM_getValue('qtd', '1') || '1').trim(),
  });
  const configurado = () => { const u = user(); return !!(u.brigada && u.nmec); };

  /* ───────────── Página atual ───────────── */
  const P = location.pathname;
  const isTarefas = /BPT_MinhasTarefas\.aspx/i.test(P);
  const isDetalhe = /Orcamento_Detalhe_NEW\.aspx/i.test(P);
  const isLista = /Orcamentos_List\.aspx/i.test(P);
  const isRecolhas = /Recolhas_List\.aspx/i.test(P);

  /* ───────────── Estado do fluxo (partilhado entre páginas) ───────────── */
  const load = () => {
    try {
      const s = JSON.parse(localStorage.getItem(CFG.stateKey) || 'null');
      if (s && Date.now() - s.ts > 3600e3) { localStorage.removeItem(CFG.stateKey); return null; }
      return s;
    } catch (e) { return null; }
  };
  const save = (s) => { localStorage.setItem(CFG.stateKey, JSON.stringify({ ...s, ts: Date.now() })); render(); };
  const patch = (p) => { const s = load(); if (!s) throw new Error('Cancelado'); save({ ...s, ...p }); };
  const clear = () => { localStorage.removeItem(CFG.stateKey); lastView = null; render(); };

  /* ───────────── Utilitários de espera (por existência, sem atrasos fixos) ───────────── */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(fn, what, timeout = CFG.timeout) {
    const t0 = Date.now();
    for (;;) {
      if (!load()) throw new Error('Cancelado');
      let v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      if (Date.now() - t0 > timeout) throw new Error('Tempo esgotado à espera de: ' + what);
      await sleep(100);
    }
  }

  // Contador de pedidos AJAX pendentes (por janela/iframe)
  function track(win) {
    try {
      if (!win || win.__vbT) return;
      const X = win.XMLHttpRequest;
      if (!X) return;
      win.__vbT = true; win.__vbP = 0;
      const send = X.prototype.send;
      X.prototype.send = function () {
        win.__vbP++;
        this.addEventListener('loadend', () => { win.__vbP--; });
        return send.apply(this, arguments);
      };
    } catch (e) { /* ignorar */ }
  }
  const pageWin = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
  track(pageWin);

  // Espera até não haver pedidos pendentes durante um curto período contínuo
  async function waitIdle(win = pageWin, quiet = 350) {
    const t0 = Date.now();
    let since = null;
    for (;;) {
      if (!load()) throw new Error('Cancelado');
      if ((win.__vbP || 0) === 0) {
        if (since === null) since = Date.now();
        if (Date.now() - since >= quiet) return;
      } else since = null;
      if (Date.now() - t0 > CFG.timeout) throw new Error('O site não parou de carregar.');
      await sleep(50);
    }
  }

  function inFrames(sel) {
    for (const f of document.querySelectorAll('iframe')) {
      try {
        const d = f.contentDocument;
        if (!d || d.readyState !== 'complete') continue;
        const el = d.querySelector(sel);
        if (el) { track(f.contentWindow); return { frame: f, doc: d, win: f.contentWindow, el }; }
      } catch (e) { /* iframe de outro domínio */ }
    }
    return null;
  }

  // Todos os documentos (página + iframes, incluindo aninhados)
  function allDocs(root = document, out = []) {
    out.push(root);
    for (const f of root.querySelectorAll('iframe')) {
      try { const d = f.contentDocument; if (d) allDocs(d, out); } catch (e) { /* ignorar */ }
    }
    return out;
  }

  // Popup "Gerar Relatório": devolve o botão "Não" (só se "Sim" e "Não" estiverem visíveis juntos)
  function botaoNao() {
    const txt = (b) => (b.value || b.textContent || '').trim();
    for (const d of allDocs()) {
      const btns = [...d.querySelectorAll('input[type=submit],input[type=button],button,a.BotaoNemesis')]
        .filter((b) => b.offsetParent !== null);
      const sim = btns.find((b) => /^sim$/i.test(txt(b)));
      const nao = btns.find((b) => /^n[ãa]o$/i.test(txt(b)));
      if (sim && nao) return nao;
    }
    return null;
  }

  // Popup "Documentos sugeridos": devolve o botão "Continuar" (só se "Fazer upload" e "Continuar" estiverem visíveis juntos)
  function botaoContinuar() {
    const txt = (b) => (b.value || b.textContent || '').trim();
    for (const d of allDocs()) {
      const btns = [...d.querySelectorAll('input[type=submit],input[type=button],button,a.BotaoNemesis')]
        .filter((b) => b.offsetParent !== null);
      const upload = btns.find((b) => /^fazer upload$/i.test(txt(b)));
      const cont = btns.find((b) => /^continuar$/i.test(txt(b)));
      if (upload && cont) return cont;
    }
    return null;
  }

  function setVal(el, v, evts = ['input', 'change']) {
    const W = el.ownerDocument.defaultView;
    if (el.focus) el.focus();
    el.value = v;
    for (const e of evts) el.dispatchEvent(new W.Event(e, { bubbles: true }));
  }
  const erroNoSite = () => {
    const e = document.querySelector('.Feedback_Message_Error');
    return e ? e.textContent.trim() : '';
  };
  const hoje = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const visivel = (e) => !!e && e.offsetParent !== null;
  const urlDetalhe = (id) => `${CFG.base}NemesisOrcamentacao/OrcamentacaoNew.Orcamento_Detalhe_NEW.aspx?OrdemId=${id}`;
  const urlLista = (id) => `${CFG.base}Nemesis_Orc_Screens/Orcamentacao.Orcamentos_List.aspx?Source=1&OrdemId=${id}`;

  /* ───────────── Histórico do dia (apaga automaticamente o dia anterior) ───────────── */
  const HIST_KEY = 'vb_hist_v1';
  const histLoad = () => {
    try {
      const h = JSON.parse(localStorage.getItem(HIST_KEY) || 'null');
      if (h && h.dia === hoje() && Array.isArray(h.itens)) return h;
    } catch (e) { /* ignorar */ }
    const novo = { dia: hoje(), itens: [] };
    try { localStorage.setItem(HIST_KEY, JSON.stringify(novo)); } catch (e) { /* ignorar */ }
    return novo;
  };
  const histAdd = (s) => {
    const h = histLoad();
    if (h.itens.some((i) => i.ordem === s.ordem && i.tarefa === s.tarefa)) return;
    h.itens.push({ ordem: s.ordem, tarefa: s.tarefa, obs: s.obs, hora: new Date().toTimeString().slice(0, 5) });
    try { localStorage.setItem(HIST_KEY, JSON.stringify(h)); } catch (e) { /* ignorar */ }
  };
  histLoad(); // ao arrancar, limpa já os dados de dias anteriores

  /* ───────────── Passos do fluxo ───────────── */
  async function passoPesquisa(s) {
    patch({ prog: 0, nota: 'A pesquisar a ordem…' });
    await waitIdle();
    const inp = await waitFor(() => document.getElementById('wt681'), 'o campo de pesquisa da ordem');
    setVal(inp, s.ordem);
    const btn = await waitFor(() => document.getElementById('wtSearchLink'), 'o botão Pesquisar');
    btn.click();
    await waitIdle();
    const link = await waitFor(
      () => [...document.querySelectorAll('a[id*="ListaTarefasOrdemProjeto"]')].find((a) => a.textContent.trim().toUpperCase() === s.ordem),
      `a ordem ${s.ordem} nos resultados`
    );
    patch({ step: 'detalhe', nota: 'A abrir o detalhe da ordem…' });
    link.click();
  }

  async function passoDetalhe(s) {
    const id = new URLSearchParams(location.search).get('OrdemId');
    if (!id) throw new Error('Não encontrei o OrdemId no endereço do detalhe.');
    patch({ ordemId: id, step: 'lista', prog: 1, nota: 'A abrir a lista de orçamentos…' });
    location.href = urlLista(id);
  }

  async function passoLista(s) {
    patch({ prog: 1, nota: 'A abrir o popup de novo orçamento…' });
    await waitIdle();
    const add = await waitFor(() => document.getElementById('wtaddOrcamento') || document.getElementById('wtimg_add'), 'o botão Adicionar orçamento');
    add.click();
    await waitFor(() => inFrames('#wtORCAMENTO_Descricao'), 'o popup de novo orçamento');
    patch({ prog: 2, nota: 'A preencher a descrição do orçamento…' });
    const campo = await waitFor(() => inFrames('#wtORCAMENTO_Descricao'), 'o campo da descrição');
    setVal(campo.el, CFG.descricaoOrcamento);
    await waitIdle(campo.win);
    const gravar = await waitFor(() => { const x = inFrames('#wtORCAMENTO_Descricao'); return x && x.doc.getElementById('wt11'); }, 'o botão Gravar do popup');
    if (gravar.ownerDocument.getElementById('wtORCAMENTO_Descricao').value !== CFG.descricaoOrcamento) throw new Error('A descrição do orçamento não ficou preenchida.');
    gravar.click();
    await waitFor(() => !inFrames('#wtORCAMENTO_Descricao'), 'o fecho do popup (o orçamento pode não ter sido gravado)');
    await waitIdle();
    const link = await waitFor(() => document.getElementById('wt338'), 'o link Recolhas da Ordem');
    patch({ step: 'recolha', prog: 3, nota: 'A abrir as recolhas…' });
    location.href = link.href;
  }

  // Usado por "Continuar" quando o orçamento foi criado à mão
  async function passoListaParaRecolha() {
    await waitIdle();
    const link = await waitFor(() => document.getElementById('wt338'), 'o link Recolhas da Ordem');
    patch({ prog: 3, nota: 'A abrir as recolhas…' });
    location.href = link.href;
  }

  async function passoRecolha(s) {
    const u = user();
    if (!u.brigada || !u.nmec) throw new Error('Falta configurar a brigada e o nº mecânico (ícone ⚙ do painel).');
    patch({ prog: 3, nota: 'A preencher a recolha…' });
    await waitIdle();
    const g = (id) => document.getElementById(id);
    const formVisivel = () => visivel(g('wtWBAddTarefas_wtInputTarefa'));

    // Se o formulário estiver escondido, clica no "T" (imagem) que o abre
    if (!formVisivel()) {
      patch({ nota: 'A abrir o formulário de tarefas (T)…' });
      const t = await waitFor(() => document.querySelector(CFG.abrirTarefasSel), 'o ícone "T" das tarefas', 15000);
      t.click();
      await waitFor(formVisivel, 'o formulário de adicionar tarefa (depois de clicar no T)', 20000);
      await waitIdle();
    }
    patch({ nota: 'A preencher a recolha…' });

    const campos = [
      ['wtWBAddTarefas_wtInputTarefa', s.tarefa],
      ['wtWBAddTarefas_wtRecolha_Brigada', u.brigada],
      ['wtWBAddTarefas_wtRecolha_Nmec', u.nmec],
      ['wtWBAddTarefas_wtRecolha_DataSP', hoje()],
      ['wtWBAddTarefas_wtRecolha_Qtd', u.qtd],
    ];
    for (const [id, v] of campos) {
      const el = await waitFor(() => g(id), 'o campo ' + id);
      setVal(el, v);
      await waitIdle();
    }
    for (const [id, v] of campos) {
      const el = g(id);
      if (!el || el.value !== v) throw new Error(`O campo ${id} ficou com "${el ? el.value : '—'}" em vez de "${v}".`);
    }
    const add = await waitFor(() => g('wtWBAddTarefas_wtimg_nova_tarefa'), 'o botão de adicionar tarefa');
    add.click();
    await waitIdle();
    if (erroNoSite()) throw new Error(erroNoSite());
    const sub = await waitFor(() => { const b = g('wtbtnSubmeter'); return b && !b.disabled && b; }, 'o botão Submeter Recolhas');
    patch({ step: 'resposta', nota: 'A submeter as recolhas…' });
    sub.click();
    await waitIdle();
    await voltarAoDetalhe(s);
  }

  async function voltarAoDetalhe(s) {
    patch({ prog: 3, nota: 'A confirmar a recolha…' });
    await waitIdle();
    if (erroNoSite()) throw new Error(erroNoSite());
    patch({ prog: 4, nota: 'A voltar ao orçamento…' });
    location.href = urlDetalhe(s.ordemId);
  }

  // Botão que confirma o popup de resposta: seletor configurado e, se não existir, deteção por texto
  function botaoConfirmar(doc) {
    if (CFG.confirmarSel) {
      const b = doc.querySelector(CFG.confirmarSel);
      if (b) return b;
    }
    const vis = (b) => b.offsetParent !== null && !/\bInvisible\b/.test(b.className);
    const txt = (b) => (b.value || b.textContent || '').trim();
    const c = [...doc.querySelectorAll('input[type=submit],input[type=button],button,a.BotaoNemesis')]
      .filter((b) => vis(b) && /^(submeter|gravar|confirmar|guardar|enviar|ok)\b/i.test(txt(b)));
    return c.find((b) => /^gravar$/i.test(txt(b))) || (c.length === 1 ? c[0] : null);
  }
  const listaBotoes = (doc) => [...doc.querySelectorAll('input[type=submit],input[type=button],button,a.BotaoNemesis')]
    .map((b) => `${b.id || '(sem id)'}: "${(b.value || b.textContent || '').trim()}"`).join(' | ');

  async function passoResposta(s) {
    patch({ prog: 4, nota: 'A abrir a resposta…' });
    await waitIdle();
    const btn = await waitFor(
      () => [...document.querySelectorAll('input[type=submit],input[type=button],button')].find((b) => /^submeter resposta$/i.test((b.value || b.textContent || '').trim())),
      'o botão Submeter Resposta'
    );
    btn.click();
    let f = await waitFor(() => inFrames('#wtOrdem_Resposta'), 'o popup de resposta');
    if (![...f.el.options].some((o) => o.value === CFG.respostaValor)) throw new Error(`A opção ${CFG.respostaValor} não existe no popup.`);
    patch({ nota: 'A escolher a resposta…' });
    setVal(f.el, CFG.respostaValor, ['change']);
    await waitIdle(f.win);
    f = await waitFor(() => inFrames('#wtObservacoes'), 'o campo das observações');
    setVal(f.el, s.obs, ['input', 'keyup', 'change']);
    await waitIdle(f.win);

    // Validação
    f = await waitFor(() => inFrames('#wtObservacoes'), 'o popup de resposta (validação)');
    const sel = f.doc.getElementById('wtOrdem_Resposta');
    const obs = f.doc.getElementById('wtObservacoes');
    if (!sel || sel.value !== CFG.respostaValor) throw new Error('A resposta não ficou selecionada.');
    if (!obs || obs.value !== s.obs) throw new Error('As observações não ficaram preenchidas como esperado.');
    const conf = await waitFor(() => botaoConfirmar(f.doc), 'o botão de confirmar do popup', 8000).catch(() => {
      throw new Error('Não consegui identificar o botão que confirma o popup. Botões encontrados: ' + listaBotoes(f.doc));
    });

    // Confirmação manual (opcional)
    if (s.confirmar !== false) {
      const ok = await confirmar({
        Ordem: s.ordem,
        Resposta: sel.options[sel.selectedIndex].text,
        Observações: s.obs,
      });
      if (!ok) { clear(); return; }
    }

    patch({ step: 'fim', prog: 5, nota: 'A submeter a resposta…' });
    conf.click();

    let naoClicado = false, contClicado = false;
    await waitFor(() => {
      // Popup "Gerar Relatório": responde "Não"
      if (!naoClicado) {
        const nao = botaoNao();
        if (nao) {
          naoClicado = true;
          nao.click();
          patch({ nota: 'Popup "Gerar Relatório": cliquei em Não.' });
        }
      }
      // Popup "Documentos sugeridos": clica em "Continuar"
      if (!contClicado) {
        const c = botaoContinuar();
        if (c) {
          contClicado = true;
          c.click();
          patch({ nota: 'Popup "Documentos sugeridos": cliquei em Continuar.' });
        }
      }
      return false;
    }, 'a transição da ordem', 600000);
  }

  async function passoFim(s) {
    patch({ prog: 5, nota: 'A confirmar a transição…' });
    await waitIdle();
    const msg = await waitFor(
      () => [...document.querySelectorAll('.Feedback_Message_Success')].find((e) => e.textContent.includes(s.ordem)),
      'a mensagem de sucesso da transição',
      60000
    );
    histAdd(s);
    patch({ step: 'concluido', prog: 6, nota: msg.textContent.trim() });
  }

  async function run() {
    const s = load();
    if (!s || s.erro) return;
    try {
      if (isTarefas && s.step === 'pesquisa') await passoPesquisa(s);
      else if (isDetalhe && s.step === 'detalhe') await passoDetalhe(s);
      else if (isLista && s.step === 'lista') await passoLista(s);
      else if (isLista && s.step === 'recolha') await passoListaParaRecolha();
      else if (isRecolhas && s.step === 'recolha') await passoRecolha(s);
      else if (isRecolhas && s.step === 'resposta') await voltarAoDetalhe(s);
      else if (isDetalhe && s.step === 'resposta') await passoResposta(s);
      else if (isTarefas && s.step === 'fim') await passoFim(s);
    } catch (e) {
      if (e.message === 'Cancelado') return;
      try { patch({ erro: e.message }); } catch (_) { /* estado removido */ }
    }
  }

  /* ───────────── Retoma após erro ───────────── */
  function repetirPasso() {
    patch({ erro: null, nota: 'A repetir o passo…' });
    run();
  }

  function continuarDepois() {
    const s = load(); if (!s) return;
    const next = NEXT[s.step];
    if (!next) { patch({ erro: null }); run(); return; }
    patch({ erro: null, step: next, prog: PROG[next] ?? s.prog, nota: 'A continuar (passo anterior feito à mão)…' });
    const id = s.ordemId;
    if (next === 'lista' && id && !isLista) { location.href = urlLista(id); return; }
    if (next === 'recolha' && id && !isLista && !isRecolhas) { location.href = urlLista(id); return; }
    if (next === 'resposta' && id && !isDetalhe && !isRecolhas) { location.href = urlDetalhe(id); return; }
    run();
  }

  /* ───────────── Ligação ao Nemesis Dock (contrato v1) ─────────────
     A barra (ícone, balão, pílulas, posição dos painéis) vive no script "Nemesis Dock".
     Este script só se regista nela e envia-lhe o estado. Sem o Dock instalado, não arranca.
     Mensagens: CustomEvent no document, com o detail em string JSON (os scripts correm isolados).
       registar {id,nome,versao,ordem} · estado {id,naLista,estado,pilula,contador,progresso,dica,dispensavel}
       abrir {id} · fechar {id} · remover {id}   |   o Dock avisa o host do painel com "nemesis-dock:dispensar"
     O contrato completo está no cabeçalho do nemesis-dock.user.js. */
  const DOCK_URL = 'https://raw.githubusercontent.com/tiagodiaf/nemesis-tarefas/main/nemesis-dock.user.js';
  const ND_ID = 'vb', ND_NOME = 'Viabilidade', ND_ORDEM = 1;
  const nd = (nome, obj) => document.dispatchEvent(new CustomEvent('nemesis-dock:' + nome, { detail: JSON.stringify(obj) }));

  // Aviso pequeno e discreto, partilhado pelos 3 scripts (uma só caixa, com os nomes dos que precisam do Dock)
  function avisoDock(motivo, on) {
    let a = document.getElementById('nemesis-dock-aviso');
    const nomes = new Set(a && a.dataset.scripts ? a.dataset.scripts.split('|') : []);
    if (on) nomes.add(ND_NOME); else nomes.delete(ND_NOME);
    if (!nomes.size) { if (a) a.remove(); return; }
    if (!a) {
      a = document.createElement('div');
      a.id = 'nemesis-dock-aviso';
      const sr = a.attachShadow({ mode: 'open' });
      sr.innerHTML = `<style>
        :host{all:initial;position:fixed;z-index:2147483647;right:110px;bottom:10px;font:12px/1.35 "Segoe UI",system-ui,sans-serif}
        .av{display:flex;align-items:center;gap:10px;max-width:360px;padding:7px 10px;background:#fff;color:#475467;border:1px solid #d0d5dd;border-radius:10px;box-shadow:0 2px 10px rgba(20,30,50,.12)}
        a{color:#17202a;font-weight:600;text-decoration:underline;white-space:nowrap}
        button{border:0;background:none;color:#98a2b3;font-size:16px;line-height:1;cursor:pointer;padding:0}button:hover{color:#17202a}
      </style><div class="av"><slot></slot><a href="${DOCK_URL}" target="_blank" rel="noopener">Instalar</a><button title="Fechar" aria-label="Fechar">×</button></div>`;
      sr.querySelector('button').addEventListener('click', () => a.remove());
      a.appendChild(document.createElement('span'));
      document.documentElement.appendChild(a);
    }
    if (on) a.dataset.motivo = motivo;
    a.dataset.scripts = [...nomes].join('|');
    a.querySelector('span').textContent = (a.dataset.motivo === 'versao'
      ? 'O Nemesis Dock instalado não é compatível. Instala a versão mais recente.'
      : 'Falta instalar o Nemesis Dock.') + ' Necessário para: ' + [...nomes].join(', ');
  }

  // Espera pelo Dock (a ordem de arranque entre scripts não é garantida). Passados ~5 s mostra o aviso,
  // mas continua à escuta: se o Dock chegar, o aviso desaparece e o script arranca.
  function esperarDock(ms = 5000) {
    return new Promise((res) => {
      let feito = false, t = null;
      const contrato = () => { const dk = document.getElementById('nemesis-dock'); return dk ? (dk.dataset.contrato || '') : null; };
      const tentar = () => {
        if (feito) return;
        const c = contrato();
        if (c === '1') {
          feito = true;
          clearTimeout(t);
          document.removeEventListener('nemesis-dock:pronto', tentar);
          avisoDock('', false);
          res();
        } else if (c) avisoDock('versao', true);   // Dock presente mas com outro contrato
      };
      document.addEventListener('nemesis-dock:pronto', tentar);
      tentar();
      if (!feito) t = setTimeout(() => { if (!feito) avisoDock(contrato() ? 'versao' : 'falta', true); }, ms);
    });
  }
  await esperarDock();

  /* ───────────── Interface ───────────── */
  const CSS = `
    :host{all:initial;display:contents}
    *{box-sizing:border-box;font-family:"Segoe UI",system-ui,sans-serif}
    .btn:focus-visible,.inp:focus-visible,textarea:focus-visible{outline:3px solid #9ca3af;outline-offset:2px}
    .panel{position:relative;width:340px;max-height:80vh;overflow:auto;background:#fff;color:#17202a;
      border:1px solid #d9dee6;border-radius:12px;box-shadow:0 14px 40px rgba(20,30,50,.22);font-size:14px}
    .panel[hidden]{display:none}
    header{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #e6e9ef;background:#f3f5f8;border-radius:12px 12px 0 0}
    header strong{font-size:15px}header .sub{color:#667085;font-size:12px;flex:1}
    .x{border:0;background:none;font-size:20px;line-height:1;cursor:pointer;color:#667085}
    .x.gear{font-size:16px}
    .body{padding:14px}
    .lbl{display:block;font-weight:600;margin:12px 0 6px}.lbl:first-child{margin-top:0}
    .inp{width:100%;padding:9px 10px;border:1px solid #c5ccd8;border-radius:8px;font-size:14px}
    .mono{font-family:Consolas,"Courier New",monospace;letter-spacing:.3px}
    .info{min-height:20px;margin-top:6px;font-size:13px;color:#667085}.info.ok{color:#17825D;font-weight:600}.info.bad{color:#b26a00}
    .chips{display:flex;flex-wrap:wrap;gap:6px}.chip input{position:absolute;opacity:0}
    .chip span{display:inline-block;padding:6px 11px;border:1px solid #c5ccd8;border-radius:999px;cursor:pointer;font-size:13px;background:#fff}
    .chip input:checked+span{background:#1f2937;border-color:#1f2937;color:#fff}
    .chip input:focus-visible+span{outline:3px solid #9ca3af}
    .chk{display:flex;align-items:center;gap:8px;margin-top:14px;font-size:13px;cursor:pointer;color:#17202a}
    .chk input{width:16px;height:16px;cursor:pointer}
    textarea{width:100%;margin-top:8px;padding:9px 10px;border:1px solid #c5ccd8;border-radius:8px;font-size:14px;resize:vertical}
    .cnt{text-align:right;font-size:12px;color:#667085}
    .btn{width:100%;margin-top:14px;padding:10px;border-radius:8px;border:1px solid #c5ccd8;background:#fff;font-size:14px;font-weight:600;cursor:pointer}
    .btn.primary{background:#1f2937;border-color:#1f2937;color:#fff}.btn.primary:disabled{background:#cbd2dc;border-color:#cbd2dc;cursor:not-allowed}
    .btn.ghost{color:#475467}.row{display:flex;gap:8px}.row .btn{margin-top:14px}
    .ordem{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
    .tag{background:#eceff3;color:#111827;border-radius:6px;padding:2px 8px;font-size:12px;font-weight:600}
    .steps{list-style:none;margin:0;padding:0}
    .steps li{display:flex;align-items:center;gap:10px;padding:6px 0;color:#98a2b3;position:relative}
    .steps li:not(:last-child)::after{content:"";position:absolute;left:8px;top:26px;height:calc(100% - 12px);border-left:2px solid #e1e5ec}
    .steps i{width:18px;height:18px;border-radius:50%;border:2px solid #c5ccd8;background:#fff;flex:none;z-index:1}
    .steps li.done{color:#17202a}.steps li.done i{background:#17825D;border-color:#17825D;box-shadow:inset 0 0 0 3px #fff;}
    .steps li.cur{color:#17202a;font-weight:600}.steps li.cur i{border-color:#1f2937;border-top-color:transparent;animation:g 1s linear infinite}
    @keyframes g{to{transform:rotate(360deg)}}
    @media (prefers-reduced-motion:reduce){.steps li.cur i{animation:none;border-top-color:#1f2937}}
    .nota{margin-top:10px;padding:9px 10px;background:#f3f5f8;border-radius:8px;font-size:13px;color:#475467}
    .err{padding:10px;background:#fdecea;border:1px solid #f3b8b1;border-radius:8px;color:#8f2a20;font-size:13px;word-break:break-word}
    .okbox{padding:10px;background:#e8f6ef;border:1px solid #a9dcc2;border-radius:8px;color:#0f5a40;font-size:13px}
    .hist{margin-top:14px;font-size:13px;color:#475467}.hist summary{cursor:pointer;font-weight:600}
    .hist ul{list-style:none;margin:8px 0 0;padding:0;max-height:160px;overflow:auto}
    .hist li{padding:4px 0;border-bottom:1px solid #eef0f4;word-break:break-word}
    dl{margin:0}dt{font-weight:600;margin-top:8px}dd{margin:2px 0 0;word-break:break-word}
    @media (max-width:420px){.panel{width:calc(100vw - 16px)}}
  `;

  /* ───────────── Separador (item no balão + pílula + painel) ───────────── */
  const host = document.createElement('div');
  host.id = 'vb-host';
  host.dataset.ndPainel = ND_ID;   // o Dock adota este host e posiciona o painel
  host.style.display = 'none';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS}</style>
    <section class="panel">
      <header><strong>Viabilidade</strong><span class="sub">Nemesis · v${VERSAO}</span>
        <button class="x gear" id="gear" title="Definições" aria-label="Definições">⚙</button>
        <button class="x" id="close" aria-label="Fechar">×</button></header>
      <div class="body"></div>
    </section>`;
  const $ = (sel, el = root) => el.querySelector(sel);
  const closeBtn = $('#close');
  const body = $('.body');

  // Estado enviado ao Dock (ponto no balão, pílula) + rótulo do botão do painel
  function syncPill(s, rel, naLista) {
    const dispensada = false;
    let st = '', txt = '', pct = 0, tip = `Viabilidade v${VERSAO}`;
    if (pendingConfirm) st = 'run';
    else if (s) st = s.erro ? 'err' : s.step === 'concluido' ? 'ok' : 'run';
    if (s && st) {
      const n = Math.min((s.prog || 0) + 1, PASSOS.length);
      const passo = PASSOS[Math.min(s.prog || 0, PASSOS.length - 1)];
      if (st === 'ok') { txt = 'concluída'; pct = 100; tip += ' · concluída'; }
      else { txt = `${n}/${PASSOS.length}`; pct = Math.round(((s.prog || 0) / PASSOS.length) * 100); tip += ` · passo ${n} de ${PASSOS.length} · ${passo}${st === 'err' ? ' (erro)' : ''}`; }
    }
    closeBtn.textContent = st ? '–' : '×';
    closeBtn.title = closeBtn.ariaLabel = st ? 'Minimizar' : 'Fechar';
    nd('estado', { id: ND_ID, naLista, estado: st, pilula: !!st && !dispensada, contador: txt, progresso: pct, dica: tip,
      dispensavel: st === 'ok' || (st === 'err' && !!rel) });
  }

  const abrirNoArranque = !!load() || (isTarefas && !configurado());
  let emConfig = !configurado();
  let lastView = null, lastKey = '';
  let pendingConfirm = null;
  const draft = { ordem: '', obsTipo: OBS_OPCOES[0], obsTexto: '', esclarecimentos: false };

  // Abrir/fechar o painel é pedido ao Dock (ele garante que só há um painel aberto de cada vez)
  const setAberto = (v) => { nd(v ? 'abrir' : 'fechar', { id: ND_ID }); render(); };
  nd('registar', { id: ND_ID, nome: ND_NOME, versao: VERSAO, ordem: ND_ORDEM });
  if (abrirNoArranque) nd('abrir', { id: ND_ID });

  host.addEventListener('nemesis-dock:dispensar', () => clear());

  $('#close').addEventListener('click', () => setAberto(false));
  $('#gear').addEventListener('click', () => { emConfig = !emConfig; lastKey = ''; render(); });
  window.addEventListener('storage', (e) => { if (e.key === CFG.stateKey || (CFG.reportKey && e.key === CFG.reportKey)) { lastKey = ''; render(); } });

  function confirmar(resumo) {
    return new Promise((res) => { pendingConfirm = { resumo, res }; lastKey = ''; setAberto(true); });
  }

  function render() {
    renderInner();
  }

  function renderInner() {
    const s = load();
    const naLista = !!(isTarefas || s);
    const v = pendingConfirm ? 'confirm' : emConfig ? 'config' : !s ? 'form' : s.erro ? 'erro' : s.step === 'concluido' ? 'done' : 'run';
    syncPill(s, null, naLista);
    if ((v === 'form' || v === 'config') && lastView === v) return;
    const key = v + (s ? `${s.prog}|${s.nota}|${s.erro || ''}` : '');
    if (key === lastKey) return;
    lastKey = key; lastView = v;
    body.replaceChildren();
    if (v === 'form') viewForm();
    else if (v === 'config') viewConfig();
    else if (v === 'confirm') viewConfirm();
    else if (v === 'erro') viewErro(s);
    else if (v === 'done') viewDone(s);
    else viewRun(s);
  }

  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

  function viewConfig() {
    const ja = configurado();
    body.append(el(`<div>
      <div class="lbl">Definições pessoais</div>
      <div class="nota" style="margin-top:0">Configura uma só vez. Ficam guardadas neste browser e usam-se em todas as recolhas.</div>
      <label class="lbl" for="c-brig">Brigada</label>
      <input id="c-brig" class="inp mono" placeholder="ex: 27/6785" autocomplete="off" spellcheck="false">
      <label class="lbl" for="c-nmec">Número mecânico</label>
      <input id="c-nmec" class="inp mono" placeholder="ex: 75086" autocomplete="off" spellcheck="false">
      <label class="lbl" for="c-qtd">Quantidade por recolha</label>
      <input id="c-qtd" class="inp mono" type="number" min="1" step="1">
      <div class="info bad" id="cerr"></div>
      <div class="row">
        ${ja ? '<button class="btn ghost" id="cback">Voltar</button>' : ''}
        <button class="btn primary" id="csave">Guardar</button>
      </div>
    </div>`));
    const u = user();
    $('#c-brig').value = u.brigada;
    $('#c-nmec').value = u.nmec;
    $('#c-qtd').value = u.qtd || '1';
    const sair = () => { emConfig = false; lastView = null; lastKey = ''; render(); };
    if (ja) $('#cback').addEventListener('click', sair);
    $('#csave').addEventListener('click', () => {
      const b = $('#c-brig').value.trim(), n = $('#c-nmec').value.trim(), q = $('#c-qtd').value.trim();
      const err = $('#cerr');
      if (!b) { err.textContent = 'Indica a brigada.'; return; }
      if (!n) { err.textContent = 'Indica o número mecânico.'; return; }
      if (!/^[1-9]\d*$/.test(q)) { err.textContent = 'A quantidade tem de ser um número inteiro (1 ou mais).'; return; }
      GM_setValue('brigada', b);
      GM_setValue('nmec', n);
      GM_setValue('qtd', q);
      sair();
    });
  }

  function viewForm() {
    const u = user();
    body.append(el(`<div>
      <div class="tag" id="quem"></div>
      <label class="lbl" for="ordem">Número da ordem</label>
      <input id="ordem" class="inp mono" placeholder="26VB_ORAP_xxxxx" autocomplete="off" spellcheck="false">
      <div class="info" id="info"></div>
      <label class="chk"><input type="checkbox" id="esc"><span>Esclarecimentos diversos (${CFG.tarefaEsclarecimentos})</span></label>
      <div class="lbl">Observações da resposta</div>
      <div class="chips" role="radiogroup">
        ${OBS_OPCOES.map((o) => `<label class="chip"><input type="radio" name="obs" value="${o}"><span>${o}</span></label>`).join('')}
        <label class="chip"><input type="radio" name="obs" value="__outro"><span>Outro texto</span></label>
      </div>
      <div id="livre" hidden>
        <textarea id="txt" rows="3" maxlength="${CFG.obsMax}" placeholder="Escreve a observação"></textarea>
        <div class="cnt"><span id="n">0</span>/${CFG.obsMax}</div>
      </div>
      <label class="chk"><input type="checkbox" id="pedir"><span>Confirmar antes de enviar a resposta</span></label>
      <button class="btn primary" id="go" disabled>Iniciar viabilidade</button>
      <details class="hist" id="hist"><summary>Hoje: <span id="hn">0</span> concluída(s)</summary><ul id="hl"></ul></details>
    </div>`));
    $('#quem').textContent = `Brigada ${u.brigada} · Mec. ${u.nmec}`;
    const ordem = $('#ordem'), info = $('#info'), livre = $('#livre'), txt = $('#txt'), go = $('#go'), pedir = $('#pedir'), esc = $('#esc');
    ordem.value = draft.ordem; txt.value = draft.obsTexto; $('#n').textContent = txt.value.length;
    esc.checked = draft.esclarecimentos;
    pedir.checked = GM_getValue('confirmarAntes', true) !== false;
    pedir.addEventListener('change', () => GM_setValue('confirmarAntes', pedir.checked));
    root.querySelectorAll('input[name=obs]').forEach((r) => { r.checked = r.value === draft.obsTipo; });

    // Histórico do dia (mais recentes primeiro)
    const itens = histLoad().itens;
    $('#hn').textContent = itens.length;
    const hl = $('#hl');
    [...itens].reverse().forEach((i) => {
      const li = document.createElement('li');
      li.textContent = `${i.hora} · ${i.ordem} · ${i.tarefa} · ${i.obs}`;
      hl.appendChild(li);
    });

    const parse = () => {
      const o = ordem.value.trim().toUpperCase();
      const m = /^[A-Z0-9]+_(ORAP|ORAC)_\d+$/.exec(o);
      if (!m) return null;
      const esclarecimentos = draft.esclarecimentos;
      return {
        ordem: o,
        tipo: m[1],
        tarefa: esclarecimentos ? CFG.tarefaEsclarecimentos : CFG.tarefas[m[1]],
        esclarecimentos,
      };
    };
    const obsFinal = () => (draft.obsTipo === '__outro' ? draft.obsTexto.trim() : draft.obsTipo);
    const refresh = () => {
      const p = parse();
      const raw = ordem.value.trim();
      info.className = 'info' + (p ? ' ok' : raw ? ' bad' : '');
      info.textContent = p
        ? `${p.tipo} · tarefa ${p.tarefa}${p.esclarecimentos ? ' (esclarecimentos)' : ''}`
        : raw ? 'Formato esperado: 26VB_ORAP_083614 (ORAP ou ORAC)' : '';
      livre.hidden = draft.obsTipo !== '__outro';
      go.disabled = !(p && obsFinal());
    };
    ordem.addEventListener('input', () => { ordem.value = ordem.value.toUpperCase(); draft.ordem = ordem.value; refresh(); });
    esc.addEventListener('change', () => { draft.esclarecimentos = esc.checked; refresh(); });
    root.querySelectorAll('input[name=obs]').forEach((r) => r.addEventListener('change', () => { draft.obsTipo = r.value; refresh(); if (r.value === '__outro') txt.focus(); }));
    txt.addEventListener('input', () => { draft.obsTexto = txt.value; $('#n').textContent = txt.value.length; refresh(); });
    go.addEventListener('click', () => {
      const p = parse(); if (!p) return;
      if (!configurado()) { emConfig = true; lastKey = ''; render(); return; }
      save({ ...p, obs: obsFinal(), confirmar: pedir.checked, step: 'pesquisa', prog: 0, nota: 'A iniciar…' });
      setAberto(true);
      run();
    });
    refresh();
  }

  function viewRun(s) {
    const lis = PASSOS.map((t, i) => `<li class="${i < s.prog ? 'done' : i === s.prog ? 'cur' : ''}"><i></i><span>${t}</span></li>`).join('');
    body.append(el(`<div>
      <div class="ordem"><span class="mono">${s.ordem}</span><span class="tag">${s.tipo} · ${s.tarefa}</span></div>
      <ol class="steps">${lis}</ol>
      <div class="nota"></div>
      <button class="btn ghost" id="stop">Parar</button>
    </div>`));
    $('.nota').textContent = s.nota || '';
    $('#stop').addEventListener('click', () => { if (pendingConfirm) { pendingConfirm.res(false); pendingConfirm = null; } clear(); });
  }

  function viewConfirm() {
    const r = pendingConfirm.resumo;
    const dl = Object.entries(r).map(([k]) => `<dt>${k}</dt><dd></dd>`).join('');
    const node = el(`<div><div class="lbl">Confirma antes de submeter</div><dl>${dl}</dl>
      <div class="row"><button class="btn ghost" id="no">Cancelar</button><button class="btn primary" id="yes">Submeter</button></div></div>`);
    [...node.querySelectorAll('dd')].forEach((d, i) => { d.textContent = Object.values(r)[i]; });
    body.append(node);
    $('#yes').addEventListener('click', () => { const p = pendingConfirm; pendingConfirm = null; lastKey = ''; p.res(true); render(); });
    $('#no').addEventListener('click', () => { const p = pendingConfirm; pendingConfirm = null; p.res(false); clear(); });
  }

  function viewErro(s) {
    body.append(el(`<div><div class="ordem"><span class="mono">${s.ordem}</span></div>
      <div class="err"></div>
      <div class="nota">Podes resolver à mão no ecrã e carregar em <b>Continuar</b> (assume este passo como feito), ou tentar de novo com <b>Repetir passo</b>.</div>
      <div class="row">
        <button class="btn primary" id="rep">Repetir passo</button>
        <button class="btn" id="cont">Continuar</button>
      </div>
      <button class="btn ghost" id="canc">Cancelar</button></div>`));
    $('.err').textContent = `Falhou em "${PASSOS[Math.min(s.prog || 0, PASSOS.length - 1)]}": ${s.erro}`;
    $('#rep').addEventListener('click', repetirPasso);
    $('#cont').addEventListener('click', continuarDepois);
    $('#canc').addEventListener('click', clear);
  }

  function viewDone(s) {
    body.append(el(`<div><div class="ordem"><span class="mono">${s.ordem}</span><span class="tag">${s.tipo}</span></div>
      <div class="okbox"></div><button class="btn primary" id="nova">Nova ordem</button></div>`));
    $('.okbox').textContent = s.nota || 'Concluído.';
    $('#nova').addEventListener('click', clear);
  }

  render();
  run();
})();
