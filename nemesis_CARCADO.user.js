// ==UserScript==
// @name         Nemesis CARCAD_O
// @namespace    tiago.nemesis.carcad
// @version      2.1
// @description  Lista de ordens ORAC/ORAP/Esclarecimentos em lote: pesquisa, orçamento, recolha (contrato novo ou antigo), resposta, relatório e histórico
// @match        https://nemesis.telecom.pt/*
// @run-at       document-idle
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @updateURL    https://raw.githubusercontent.com/tiagodiaf/nemesis-tarefas/main/nemesis-carcad-o.user.js
// @downloadURL  https://raw.githubusercontent.com/tiagodiaf/nemesis-tarefas/main/nemesis-carcad-o.user.js
// ==/UserScript==

(async () => {
  'use strict';

  // ▼ VERSÃO — muda só aqui (e na linha // @version do cabeçalho, que o Tampermonkey não deixa usar variáveis) ▼
  const VERSAO = '2.1';
  if (window.top !== window.self) return;

  /* ───────────── Configuração global ───────────── */
  const CFG = {
    // Tarefa por tipo e por contrato (ESC = Esclarecimentos diversos)
    tarefas: {
      novo: { ORAC: 'PJ0210', ORAP: 'PJ0211', ESC: 'PJ0902' },
      antigo: { ORAC: 'P0127', ORAP: 'P0127', ESC: 'P0136' },
    },
    respostaValor: '2569',            // "Projeto elaborado (O)" (igual ao VB)
    descricaoOrcamento: 'Orçamento',
    confirmarSel: '#wt24',            // botão "Gravar" do popup de resposta. Se não existir, usa a deteção automática
    abrirTarefasSel: 'img[src*="recolha_tarefas_seleccao_branco.png"]', // o "T" que abre o formulário de tarefas
    noFila: null,                     // opcional: expressão regular do nó da árvore a selecionar antes de pesquisar (ex: /^minha fila\b/i). null = não seleciona nada (como no VB)
    timeout: 120000,
    stateKey: 'carcad_state_v1',
    reportKey: 'carcad_report_v1',
    histKey: 'carcad_hist_v1',
    pesquisaMax: 20 * 60 * 1000,     // limite total (20 min) para escrever + pesquisar uma ordem, mesmo com o site muito lento
    cliqueEspera: 4000,              // espera inicial (ms) para ver se o clique arrancou a pesquisa; aumenta a cada tentativa
    cliquePasso: 2000,
    recarregarApos: 3 * 60 * 1000,   // se a página das Tarefas não deixar escrever/pesquisar durante 3 min, recarrega-a
    recargasMax: 2,                  // recargas permitidas por ordem
    pausaEntreOrdens: 2000,          // pausa (ms) antes de pesquisar a ordem seguinte, para o site respirar
    validacaoMax: 10 * 60 * 1000,    // tempo máximo à espera de confirmar que a ordem evoluiu
    semResultadoMax: 3,              // vezes que a pesquisa pode terminar sem a ordem aparecer antes de desistir
    base: 'https://nemesis.telecom.pt/',
    urlTarefas: 'https://nemesis.telecom.pt/NemesisBPT_Extension/TAREFAS.BPT_MinhasTarefas.aspx',
  };
  const tarefaDe = (tipo, antigo) => CFG.tarefas[antigo ? 'antigo' : 'novo'][tipo];
  const TIPOS = { ORAC: 'ORAC', ORAP: 'ORAP', ESC: 'Esclarec.' };
  const PASSOS = [
    'Pesquisar a ordem',
    'Abrir os orçamentos',
    'Criar o orçamento',
    'Submeter a recolha',
    'Responder à ordem',
    'Validar que a ordem evoluiu',
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
      if (!win || win.__ccT) return;
      const X = win.XMLHttpRequest;
      if (!X) return;
      win.__ccT = true; win.__ccP = 0; win.__ccN = 0;
      const send = X.prototype.send;
      X.prototype.send = function () {
        win.__ccP++; win.__ccN++;
        this.addEventListener('loadend', () => { win.__ccP--; });
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
      if ((win.__ccP || 0) === 0) {
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
  const sucessoNoSite = (ordem) => [...document.querySelectorAll('.Feedback_Message_Success')].find((e) => e.textContent.toUpperCase().includes(String(ordem).toUpperCase()));
  const hoje = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const visivel = (e) => !!e && e.offsetParent !== null;
  const mostrado = (e) => !!e && e.getClientRects().length > 0;
  // Indicador amarelo "Loading" do Nemesis (se existir e estiver visível, a página ainda está a trabalhar)
  const aCarregar = () => [...document.querySelectorAll('div,span')].some((e) => e.childElementCount === 0 && /^loading\.{0,3}$/i.test(e.textContent.trim()) && mostrado(e));

  // Espera que a página acabe de carregar: documento completo, sem pedidos AJAX pendentes e sem "Loading"
  async function waitPronto() {
    await waitFor(() => document.readyState === 'complete', 'o fim do carregamento da página', 180000);
    await waitFor(() => !aCarregar(), 'o fim do "Loading"', 60000).catch((e) => { if (e.message === 'Cancelado') throw e; });
    await waitIdle();
  }
  const urlDetalhe = (id) => `${CFG.base}NemesisOrcamentacao/OrcamentacaoNew.Orcamento_Detalhe_NEW.aspx?OrdemId=${id}`;
  const urlLista = (id) => `${CFG.base}Nemesis_Orc_Screens/Orcamentacao.Orcamentos_List.aspx?Source=1&OrdemId=${id}`;

  /* ───────────── Histórico do dia (apaga automaticamente o dia anterior) ───────────── */
  const histLoad = () => {
    try {
      const h = JSON.parse(localStorage.getItem(CFG.histKey) || 'null');
      if (h && h.dia === hoje() && Array.isArray(h.itens)) return h;
    } catch (e) { /* ignorar */ }
    const novo = { dia: hoje(), itens: [] };
    try { localStorage.setItem(CFG.histKey, JSON.stringify(novo)); } catch (e) { /* ignorar */ }
    return novo;
  };
  const histAdd = (s) => {
    const h = histLoad();
    if (h.itens.some((i) => i.ordem === s.ordem && i.tarefa === s.tarefa)) return;
    h.itens.push({ ordem: s.ordem, tipo: s.tipo, tarefa: s.tarefa, hora: new Date().toTimeString().slice(0, 5) });
    try { localStorage.setItem(CFG.histKey, JSON.stringify(h)); } catch (e) { /* ignorar */ }
  };
  histLoad(); // ao arrancar, limpa já os dados de dias anteriores

  /* ───────────── Pesquisa da ordem (como no VB, com as proteções do CAD) ───────────── */
  const linksResultado = () => [...document.querySelectorAll('a[id*="ListaTarefasOrdemProjeto"]')];
  // Campo "N.º Externo": pelo id (wt681, igual ao VB) e, se mudar, pelo texto da etiqueta
  const campoOrdem = () => {
    const i = document.getElementById('wt681');
    if (i) return i;
    const lab = [...document.querySelectorAll('td,th,span,label,b,strong')].find((e) => e.childElementCount === 0 && /^n\.?\s*[º°o]\s*externo\s*:?$/i.test(e.textContent.trim()));
    for (let p = lab && lab.parentElement, k = 0; p && k < 4; p = p.parentElement, k++) {
      const inp = p.querySelector('input[type=text]');
      if (inp) return inp;
    }
    return null;
  };
  const botaoPesquisar = () => document.getElementById('wtSearchLink')
    || [...document.querySelectorAll('input[type=submit],input[type=button],button')].find((b) => /^pesquisar$/i.test((b.value || b.textContent || '').trim()) && visivel(b));

  // Escreve como um utilizador: clica, escreve, e sai do campo (o site pode reagir ao "change")
  function escrever(el, v) {
    el.click();
    setVal(el, v, ['input', 'keyup', 'change']);
    if (el.blur) el.blur();
  }
  // Clique completo de rato (caso o botão só reaja a mousedown/mouseup)
  function clicarComoRato(b) {
    const W = b.ownerDocument.defaultView;
    const r = b.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, view: W, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    for (const tipo of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const E = tipo.startsWith('pointer') && W.PointerEvent ? W.PointerEvent : W.MouseEvent;
      b.dispatchEvent(new E(tipo, o));
    }
  }
  function enterNoCampo() {
    const inp = campoOrdem();
    if (!inp) return;
    const W = inp.ownerDocument.defaultView;
    inp.focus();
    for (const tipo of ['keydown', 'keypress', 'keyup']) {
      inp.dispatchEvent(new W.KeyboardEvent(tipo, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    }
  }

  // Opcional: seleciona um nó da árvore da esquerda antes de pesquisar (só se CFG.noFila estiver definido)
  const noFila = () => (CFG.noFila
    ? [...document.querySelectorAll('a.nodeSel, a[id^="sdprgscreen"]')].find((a) => CFG.noFila.test(a.textContent.trim())) || null
    : null);
  async function ativarFila() {
    if (!CFG.noFila) return true;
    const no = await waitFor(noFila, 'o nó da árvore a selecionar', 30000).catch((e) => { if (e.message === 'Cancelado') throw e; return null; });
    if (!no) return false;
    const n0 = pageWin.__ccN || 0;
    no.click();
    await waitFor(() => (pageWin.__ccN || 0) > n0, 'o refresh da lista', 5000).catch((e) => { if (e.message === 'Cancelado') throw e; });
    await waitPronto();
    return true;
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

  /* ───────────── Passos do fluxo ───────────── */
  async function passoPesquisa(s) {
    const deadline = Date.now() + CFG.pesquisaMax;
    const limite = (o) => { if (Date.now() > deadline) throw new Error(o); };
    patch({ prog: 0, nota: 'A aguardar que a página carregue…' });
    await waitPronto();
    if (s.idx > 0) { patch({ nota: 'A aguardar um momento antes da próxima pesquisa…' }); await sleep(CFG.pausaEntreOrdens); }
    let semResultado = 0, tentativaClique = 0;
    // Se a página não deixar escrever/pesquisar durante muito tempo, recarrega-se (um número limitado de vezes por ordem)
    const recargas = s.recargas || 0;
    const tPagina = Date.now();
    const recarregarSePreso = async (motivo) => {
      if (Date.now() - tPagina < CFG.recarregarApos || recargas >= CFG.recargasMax) return;
      patch({ recargas: recargas + 1, nota: `${motivo} A recarregar a página (${recargas + 1}/${CFG.recargasMax})…` });
      location.href = CFG.urlTarefas;
      await new Promise(() => {}); // a página vai ser substituída; o passo recomeça depois de recarregar
    };

    for (let ronda = 1; ; ronda++) {
      limite('Não consegui preparar a pesquisa a tempo.');
      if (CFG.noFila) {
        patch({ nota: ronda > 1 ? `A selecionar a fila… (ronda ${ronda})` : 'A selecionar a fila…' });
        if (!(await ativarFila())) patch({ nota: 'Não encontrei o nó da fila na árvore, a continuar mesmo assim…' });
      }

      // 1) Escrever a ordem: repete até ficar mesmo no campo (o site pode apagá-lo ou refazê-lo enquanto carrega)
      for (let i = 1; ; i++) {
        limite('Não consegui escrever a ordem no campo N.º Externo (o site continuou a apagá-la).');
        await recarregarSePreso('A ordem não ficou escrita no campo.');
        patch({ nota: i > 1 || ronda > 1 ? `A escrever ${s.ordem}… (tentativa ${i})` : `A escrever ${s.ordem} no campo N.º Externo…` });
        if (i > 1 || ronda > 1) await waitPronto();
        const inp = await waitFor(() => { const x = campoOrdem(); return x && visivel(x) && !x.disabled && x; }, 'o campo N.º Externo');
        escrever(inp, s.ordem);
        await sleep(300);
        await waitPronto();
        const depois = campoOrdem();
        if (depois && depois.value === s.ordem) break;
      }

      // 2) Carregar em Pesquisar: repete (rodando as formas de clicar) até o site reagir
      const antigos = new Set(linksResultado()); // resultados anteriores não servem
      const t0 = Date.now();
      const inicio = pageWin.__ccN || 0;
      const achar = () => linksResultado().find((a) => a.textContent.trim().toUpperCase() === s.ordem.toUpperCase() && (!antigos.has(a) || Date.now() - t0 > 20000));
      const arrancou = () => (pageWin.__ccN || 0) > inicio || !!achar();
      const metodos = [(b) => b.click(), clicarComoRato, () => enterNoCampo()];
      let reiniciar = false;
      for (let k = 0; !arrancou(); k++) {
        limite('O botão Pesquisar não reagiu (o site não chegou a iniciar a pesquisa).');
        await recarregarSePreso('O botão Pesquisar não reagiu.');
        if (k >= metodos.length) { reiniciar = true; break; }
        if (k) await waitPronto();
        const b = await waitFor(() => { const x = botaoPesquisar(); return x && visivel(x) && !x.disabled && x; }, 'o botão Pesquisar');
        patch({ nota: tentativaClique ? `A pesquisar ${s.ordem}… (tentativa ${tentativaClique + 1})` : `A pesquisar ${s.ordem}… (pode demorar)` });
        metodos[k](b);
        tentativaClique++;
        await waitFor(arrancou, 'o início da pesquisa', Math.min(CFG.cliqueEspera + tentativaClique * CFG.cliquePasso, 20000)).catch((e) => { if (e.message === 'Cancelado') throw e; });
      }

      if (reiniciar) { patch({ nota: 'O botão Pesquisar não reagiu, a tentar de novo…' }); continue; }

      // 3) Esperar pelo resultado enquanto o site estiver a trabalhar; só desiste depois de ficar parado sem a ordem aparecer
      await waitPronto();
      let parado = Date.now();
      let link = null;
      for (;;) {
        link = achar();
        if (link) break;
        if ((pageWin.__ccP || 0) > 0 || aCarregar()) parado = Date.now();
        else if (Date.now() - parado > 45000) break;
        limite(`A ordem ${s.ordem} não apareceu nos resultados a tempo.`);
        if (!load()) throw new Error('Cancelado');
        await sleep(200);
      }
      if (link) {
        patch({ step: 'detalhe', nota: 'A abrir o detalhe da ordem…' });
        link.click();
        return;
      }
      if (++semResultado >= CFG.semResultadoMax) {
        throw new Error(`A ordem ${s.ordem} não apareceu nos resultados (pesquisei ${semResultado} vezes). Confirma se existe nas tuas tarefas.`);
      }
      patch({ nota: `A ordem ainda não apareceu, a repetir a pesquisa… (${semResultado}/${CFG.semResultadoMax})` });
    }
  }

  // Detalhe da ordem: guarda o OrdemId e abre a lista de orçamentos
  async function passoDetalhe(s) {
    const id = new URLSearchParams(location.search).get('OrdemId');
    if (!id) throw new Error('Não encontrei o OrdemId no endereço do detalhe.');
    patch({ ordemId: id, step: 'lista', prog: 1, nota: 'A abrir a lista de orçamentos…' });
    location.href = urlLista(id);
  }

  async function passoLista(s) {
    patch({ prog: 1, nota: 'A abrir o popup de novo orçamento…' });
    await waitPronto();
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
    await waitPronto();
    const link = await waitFor(() => document.getElementById('wt338'), 'o link Recolhas da Ordem');
    patch({ prog: 3, nota: 'A abrir as recolhas…' });
    location.href = link.href;
  }

  async function passoRecolha(s) {
    const u = user();
    if (!u.brigada || !u.nmec) throw new Error('Falta configurar a brigada e o nº mecânico (ícone ⚙ do painel).');
    patch({ prog: 3, nota: 'A preencher a recolha…' });
    await waitPronto();
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
    patch({ nota: `A preencher a recolha (${s.tarefa})…` });

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
    if (!s.ordemId) throw new Error('Não tenho o OrdemId guardado para voltar ao detalhe.');
    patch({ prog: 4, nota: 'A voltar à ordem…' });
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
    await waitPronto();
    const btn = await waitFor(
      () => [...document.querySelectorAll('input[type=submit],input[type=button],button')].find((b) => /^submeter resposta$/i.test((b.value || b.textContent || '').trim())),
      'o botão Submeter Resposta'
    );
    btn.click();
    let f = await waitFor(() => inFrames('#wtOrdem_Resposta'), 'o popup de resposta');

    const opts = [...f.el.options];
    if (!opts.some((o) => o.value === CFG.respostaValor)) {
      throw new Error(`A opção ${CFG.respostaValor} não existe no popup. Opções: ` + opts.map((o) => `${o.value}="${o.text}"`).join(' | '));
    }
    patch({ nota: 'A escolher a resposta…' });
    setVal(f.el, CFG.respostaValor, ['change']);
    await waitIdle(f.win);
    f = await waitFor(() => inFrames('#wtOrdem_Resposta'), 'o popup de resposta (validação)');
    const sel = f.doc.getElementById('wtOrdem_Resposta');
    if (!sel || sel.value !== CFG.respostaValor) throw new Error('A resposta não ficou selecionada.');
    const respostaTxt = sel.options[sel.selectedIndex].text;

    const conf = await waitFor(() => botaoConfirmar(f.doc), 'o botão de confirmar do popup', 8000).catch(() => {
      throw new Error('Não consegui identificar o botão que confirma o popup. Botões encontrados: ' + listaBotoes(f.doc));
    });

    // Confirmação manual (opcional)
    if (s.confirmar !== false) {
      const ok = await confirmar({ Ordem: `${s.ordem} (${s.idx + 1} de ${s.fila.length})`, Tipo: TIPOS[s.tipo], Tarefa: s.tarefa, Resposta: respostaTxt });
      if (!ok) { finalizar('Cancelaste a confirmação antes de enviar a resposta.'); return; }
    }

    // O estado passa a "fim" antes do clique, porque a página pode mudar logo a seguir
    patch({ step: 'fim', prog: 5, nota: 'A submeter a resposta…' });
    conf.click();

    // Depois de submeter, responde aos popups finais (como no VB): "Gerar Relatório" -> Não; "Documentos sugeridos" -> Continuar
    let naoClicado = false, contClicado = false;
    const vigiarPopups = () => {
      try {
        if (!naoClicado) {
          const nao = botaoNao();
          if (nao) { naoClicado = true; nao.click(); patch({ nota: 'Popup "Gerar Relatório": cliquei em Não.' }); }
        }
        if (!contClicado) {
          const c = botaoContinuar();
          if (c) { contClicado = true; c.click(); patch({ nota: 'Popup "Documentos sugeridos": cliquei em Continuar.' }); }
        }
      } catch (_) { /* estado removido ou página a mudar */ }
    };
    const vigia = setInterval(vigiarPopups, 300);

    try {
      await waitFor(() => !inFrames('#wtOrdem_Resposta'), 'o fecho do popup de resposta', 180000);
      // Só avança (e só deixa pesquisar a ordem seguinte) depois de o site confirmar a evolução da ordem
      const nota = await validarEvolucao(s);
      avancar('ok', nota, PASSOS[5]);
    } catch (e) {
      try { patch({ step: 'resposta' }); } catch (_) { /* estado removido */ }
      throw e;
    } finally {
      clearInterval(vigia);
    }
  }

  async function passoFim(s) {
    patch({ prog: 5, nota: 'A validar que a ordem evoluiu…' });
    const nota = await validarEvolucao(s);
    avancar('ok', nota, PASSOS[5]);
  }

  /* ───────────── Fila de ordens e relatório ───────────── */
  const SEM_MSG = 'A página voltou às Tarefas, mas sem mensagem de confirmação (confirma no Nemesis).';

  // Validação: a ordem só conta como evoluída quando o site o confirma (mensagem de sucesso, ou a página
  // assentou de novo nas Tarefas). Enquanto o site estiver a trabalhar, espera sem pressa.
  async function validarEvolucao(s) {
    patch({ step: 'fim', prog: 5, nota: 'A validar que a ordem evoluiu…' });
    const t0 = Date.now();
    let parado = Date.now();
    for (;;) {
      if (!load()) throw new Error('Cancelado');
      if (erroNoSite()) throw new Error(erroNoSite());
      const ocupado = (pageWin.__ccP || 0) > 0 || aCarregar() || document.readyState !== 'complete';
      if (ocupado) parado = Date.now();
      else {
        const msg = sucessoNoSite(s.ordem);
        if (msg) return msg.textContent.trim();
        const calmo = Date.now() - parado;
        if (isTarefas && calmo > 8000) return SEM_MSG;
        if (!isTarefas && calmo > 60000) throw new Error('A ordem não parece ter evoluído: a página não mudou nem mostrou confirmação.');
      }
      if (Date.now() - t0 > CFG.validacaoMax) throw new Error('A validação da evolução da ordem demorou demasiado.');
      await sleep(200);
    }
  }
  const passoAtual = (s) => PASSOS[Math.min(s.prog || 0, PASSOS.length - 1)];
  const lerRelatorio = () => { try { return JSON.parse(localStorage.getItem(CFG.reportKey) || 'null'); } catch (e) { return null; } };

  // Fecha a ordem atual e passa à seguinte (ou termina e mostra o relatório)
  function avancar(estado, nota, passo) {
    const s = load(); if (!s) throw new Error('Cancelado');
    if (estado === 'ok') histAdd(s);
    const res = [...s.res, { ordem: s.ordem, tipo: s.tipo, tarefa: s.tarefa, estado, passo: passo || '', nota: nota || '', seg: Math.round((Date.now() - s.tOrdem) / 1000) }];
    const falhas = estado === 'ok' ? 0 : (s.falhasSeguidas || 0) + 1;
    const prox = s.idx + 1;
    if (prox >= s.fila.length) { save({ ...s, res }); finalizar(''); return; }
    if (falhas >= 2) { save({ ...s, res }); finalizar('Parou depois de 2 falhas seguidas, para não repetir o mesmo problema nas restantes ordens.'); return; }
    const n = s.fila[prox];
    save({
      ...s, res, falhasSeguidas: falhas, idx: prox, ordem: n.ordem, tipo: n.tipo, tarefa: n.tarefa, ordemId: null, recargas: 0,
      step: 'pesquisa', prog: 0, erro: null, tOrdem: Date.now(), nota: 'A passar à ordem seguinte…',
    });
    // Abre sempre uma página de Tarefas limpa para a pesquisa seguinte (mais fiável do que reutilizar a anterior)
    location.href = CFG.urlTarefas;
  }

  // Guarda o relatório, termina o fluxo (parando qualquer passo em curso) e mostra-o
  function finalizar(paragem) {
    const s = load();
    if (s) {
      const res = [...s.res];
      if (!res.some((r) => r.ordem === s.ordem)) {
        res.push({ ordem: s.ordem, tipo: s.tipo, tarefa: s.tarefa, estado: s.erro ? 'erro' : 'interrompida', passo: passoAtual(s), nota: s.erro || 'Interrompida antes de terminar.', seg: Math.round((Date.now() - s.tOrdem) / 1000) });
      }
      try { localStorage.setItem(CFG.reportKey, JSON.stringify({ ts: Date.now(), inicio: s.inicio, paragem: paragem || '', fila: s.fila, res })); } catch (_) { /* ignorar */ }
    }
    localStorage.removeItem(CFG.stateKey);
    lastView = null; lastKey = '';
    setAberto(true);
  }

  function saltarOrdem() {
    const s = load(); if (!s) return;
    avancar('erro', s.erro || 'Saltada manualmente.', passoAtual(s));
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
      else if (isDetalhe && s.step === 'fim') {
        // A página recarregou o detalhe depois da resposta: segue para as Tarefas para confirmar
        await waitPronto();
        if (erroNoSite()) { patch({ step: 'resposta' }); throw new Error(erroNoSite()); }
        location.href = CFG.urlTarefas;
      }
    } catch (e) {
      if (e.message === 'Cancelado') return;
      const cur = load();
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
    if (next === 'fim' && !isTarefas) { location.href = CFG.urlTarefas; return; }
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
  const ND_ID = 'carcad', ND_NOME = 'CARCAD_O', ND_ORDEM = 3;
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
    :host{all:initial;display:contents;--c:#1f2937;--ch:#111827;--cs:#eceff3;--cf:#9ca3af;--cd:#cbd2dc}
    *{box-sizing:border-box;font-family:"Segoe UI",system-ui,sans-serif}
    .btn:focus-visible,.inp:focus-visible,textarea:focus-visible{outline:3px solid var(--cf);outline-offset:2px}
    .panel{position:relative;width:380px;max-height:80vh;overflow:auto;background:#fff;color:#17202a;
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
    .chk{display:flex;align-items:center;gap:8px;margin-top:14px;font-size:13px;cursor:pointer;color:#17202a}
    .chk input{width:16px;height:16px;cursor:pointer}
    .btn{width:100%;margin-top:14px;padding:10px;border-radius:8px;border:1px solid #c5ccd8;background:#fff;font-size:14px;font-weight:600;cursor:pointer}
    .btn.primary{background:var(--c);border-color:var(--c);color:#fff}.btn.primary:disabled{background:var(--cd);border-color:var(--cd);cursor:not-allowed}
    .btn.ghost{color:#475467}.row{display:flex;gap:8px}.row .btn{margin-top:14px}
    .ordem{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
    .tag{background:var(--cs);color:var(--ch);border-radius:6px;padding:2px 8px;font-size:12px;font-weight:600}
    .steps{list-style:none;margin:0;padding:0}
    .steps li{display:flex;align-items:center;gap:10px;padding:6px 0;color:#98a2b3;position:relative}
    .steps li:not(:last-child)::after{content:"";position:absolute;left:8px;top:26px;height:calc(100% - 12px);border-left:2px solid #e1e5ec}
    .steps i{width:18px;height:18px;border-radius:50%;border:2px solid #c5ccd8;background:#fff;flex:none;z-index:1}
    .steps li.done{color:#17202a}.steps li.done i{background:#17825D;border-color:#17825D;box-shadow:inset 0 0 0 3px #fff;}
    .steps li.cur{color:#17202a;font-weight:600}.steps li.cur i{border-color:var(--c);border-top-color:transparent;animation:g 1s linear infinite}
    @keyframes g{to{transform:rotate(360deg)}}
    @media (prefers-reduced-motion:reduce){.steps li.cur i{animation:none;border-top-color:var(--c)}}
    .nota{margin-top:10px;padding:9px 10px;background:#f3f5f8;border-radius:8px;font-size:13px;color:#475467}
    .err{padding:10px;background:#fdecea;border:1px solid #f3b8b1;border-radius:8px;color:#8f2a20;font-size:13px;word-break:break-word}
    dl{margin:0}dt{font-weight:600;margin-top:8px}dd{margin:2px 0 0;word-break:break-word}
    .bar{height:6px;background:#e1e5ec;border-radius:999px;overflow:hidden;margin:0 0 12px}.bar i{display:block;height:100%;background:var(--c);transition:width .3s}
    .sum{font-size:13px;color:#475467;margin-bottom:8px}
    .rep{list-style:none;margin:10px 0 0;padding:0;max-height:240px;overflow:auto;border:1px solid #e6e9ef;border-radius:8px}
    .rep li{display:flex;gap:8px;padding:7px 9px;border-bottom:1px solid #eef0f4;font-size:12.5px;align-items:flex-start}.rep li:last-child{border-bottom:0}
    .rep b{flex:none;width:16px;text-align:center}.rep .o{font-family:Consolas,"Courier New",monospace;word-break:break-all}
    .rep .n{color:#667085;font-size:12px;word-break:break-word}
    .rep .ok b{color:#17825D}.rep .ko b{color:#c0392b}.rep .pa b{color:#b26a00}.rep .pe b{color:#98a2b3}
    textarea.inp{margin-top:0;resize:vertical}
    .bulk{display:flex;align-items:center;gap:6px;margin-top:10px;flex-wrap:wrap;font-size:12.5px;color:#475467}
    .bulk .sep{width:1px;height:18px;background:#d9dee6;margin:0 2px}
    .mini{padding:4px 10px;border:1px solid #c5ccd8;border-radius:999px;background:#fff;font-size:12px;font-weight:600;cursor:pointer;color:#17202a}
    .mini:hover{background:var(--cs);border-color:var(--c)}
    .ords{list-style:none;margin:8px 0 0;padding:0;max-height:220px;overflow:auto;border:1px solid #e6e9ef;border-radius:8px}
    .ord{display:grid;grid-template-columns:minmax(0,1fr) 52px 122px;align-items:center;gap:6px 8px;padding:6px 9px;border-bottom:1px solid #eef0f4;border-left:3px solid transparent}
    .ord:last-child{border-bottom:0}
    .ord.sem{border-left-color:#e0a030;background:#fffaf0}
    .ord .o{font-family:Consolas,"Courier New",monospace;font-size:12.5px;word-break:break-all;min-width:0}
    .ord .tar{font-family:Consolas,"Courier New",monospace;font-size:12px;font-weight:600;color:var(--ch);text-align:right}
    .old{display:flex;align-items:center;gap:4px;font-size:12px;color:#475467;cursor:pointer;user-select:none;white-space:nowrap}
    .old input{width:14px;height:14px;cursor:pointer;margin:0}
    .ord .seg{grid-column:1/-1}
    .ord.head{position:sticky;top:0;background:#f3f5f8;z-index:2;padding-top:5px;padding-bottom:5px}
    .seg{display:flex;gap:4px;flex:none}
    .chip{position:relative}.chip input{position:absolute;opacity:0;pointer-events:none}
    .chip span{display:inline-block;padding:4px 9px;border:1px solid #c5ccd8;border-radius:999px;cursor:pointer;font-size:12px;background:#fff;user-select:none}
    .chip input:checked+span{background:var(--c);border-color:var(--c);color:#fff}
    .chip input:focus-visible+span{outline:3px solid var(--cf)}
    .hist{margin-top:14px;font-size:13px;color:#475467}.hist summary{cursor:pointer;font-weight:600}
    .hist ul{list-style:none;margin:8px 0 0;padding:0;max-height:160px;overflow:auto}
    .hist li{padding:4px 0;border-bottom:1px solid #eef0f4;word-break:break-word}
    @media (max-width:420px){.panel{width:calc(100vw - 16px)}}
  `;

  /* ───────────── Separador (item no balão + pílula + painel) ───────────── */
  const host = document.createElement('div');
  host.id = 'carcad-host';
  host.dataset.ndPainel = ND_ID;   // o Dock adota este host e posiciona o painel
  host.style.display = 'none';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS}</style>
    <section class="panel">
      <header><strong>CARCAD_O</strong><span class="sub">Nemesis · v${VERSAO}</span>
        <button class="x gear" id="gear" title="Definições" aria-label="Definições">⚙</button>
        <button class="x" id="close" aria-label="Fechar">×</button></header>
      <div class="body"></div>
    </section>`;
  const $ = (sel, el = root) => el.querySelector(sel);
  const closeBtn = $('#close');
  const body = $('.body');

  // Estado enviado ao Dock (ponto no balão, pílula) + rótulo do botão do painel
  function syncPill(s, rel, naLista) {
    let st = '', txt = '', pct = 0, tip = `CARCAD_O v${VERSAO}`, dispensada = false;
    if (pendingConfirm) st = 'run';
    else if (s) st = s.erro ? 'err' : 'run';
    else if (rel) st = rel.res.every((r) => r.estado === 'ok') && rel.res.length === rel.fila.length ? 'ok' : 'err';
    if (s && st) {
      const total = s.fila.length;
      txt = `${s.idx + 1}/${total}`;
      pct = Math.round((s.res.length / total) * 100);
      tip += ` · ordem ${s.idx + 1} de ${total}${st === 'err' ? ' (erro)' : ''}`;
    } else if (rel && st) {
      const ok = rel.res.filter((r) => r.estado === 'ok').length;
      txt = `${ok}/${rel.fila.length}`;
      pct = 100;
      tip += ` · relatório: ${ok} de ${rel.fila.length} ok`;
      dispensada = localStorage.getItem('nemesis_dispensado_carcad') === String(rel.ts);
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
  const draft = { lista: '', tipos: {}, antigo: {} };

  // Abrir/fechar o painel é pedido ao Dock (ele garante que só há um painel aberto de cada vez)
  const setAberto = (v) => { nd(v ? 'abrir' : 'fechar', { id: ND_ID }); render(); };
  nd('registar', { id: ND_ID, nome: ND_NOME, versao: VERSAO, ordem: ND_ORDEM });
  if (abrirNoArranque) nd('abrir', { id: ND_ID });

  host.addEventListener('nemesis-dock:dispensar', () => {
    const rel = lerRelatorio();
    if (rel) { try { localStorage.setItem('nemesis_dispensado_carcad', String(rel.ts)); } catch (_) { /* ignorar */ } }
    render();
  });

  $('#close').addEventListener('click', () => setAberto(false));
  $('#gear').addEventListener('click', () => { emConfig = !emConfig; lastKey = ''; render(); });
  window.addEventListener('storage', (e) => { if (e.key === CFG.stateKey || e.key === CFG.reportKey) { lastKey = ''; render(); } });

  function confirmar(resumo) {
    return new Promise((res) => { pendingConfirm = { resumo, res }; lastKey = ''; setAberto(true); });
  }

  function render() {
    renderInner();
  }

  function renderInner() {
    const s = load();
    const rel = s ? null : lerRelatorio();
    const naLista = !!(isTarefas || s || rel);
    const v = pendingConfirm ? 'confirm' : emConfig ? 'config' : s ? (s.erro ? 'erro' : 'run') : rel ? 'done' : 'form';
    syncPill(s, rel, naLista);
    if ((v === 'form' || v === 'config') && lastView === v) return;
    const key = v + (s ? `${s.idx}|${s.prog}|${s.nota}|${s.erro || ''}` : rel ? 'r' + rel.ts : '');
    if (key === lastKey) return;
    lastKey = key; lastView = v;
    body.replaceChildren();
    if (v === 'form') viewForm();
    else if (v === 'config') viewConfig();
    else if (v === 'confirm') viewConfirm();
    else if (v === 'erro') viewErro(s);
    else if (v === 'done') viewDone(rel);
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

  // Sem validação de formato: usa exatamente o que for colado (uma ordem por linha), sem repetidas
  const parseLista = (txt) => {
    const validas = [];
    let dup = 0;
    for (const linha of txt.split(/\r?\n/)) {
      const x = linha.trim();
      if (!x) continue;
      if (validas.some((v) => v.toUpperCase() === x.toUpperCase())) dup++;
      else validas.push(x);
    }
    return { validas, dup };
  };

  function viewForm() {
    const u = user();
    body.append(el(`<div>
      <div class="tag" id="quem"></div>
      <label class="lbl" for="lista">Ordens (uma por linha)</label>
      <textarea id="lista" class="inp mono" rows="4" placeholder="Cola aqui a coluna do Excel (uma ordem por linha)" spellcheck="false"></textarea>
      <div class="bulk" id="bulk" hidden>
        <span>Todas:</span>
        ${Object.keys(TIPOS).map((t) => `<button type="button" class="mini" data-t="${t}">${TIPOS[t]}</button>`).join('')}
      </div>
      <ul class="ords" id="ords" hidden></ul>
      <div class="info" id="info"></div>
      <label class="chk"><input type="checkbox" id="pedir"><span>Confirmar antes de enviar cada resposta</span></label>
      <button class="btn primary" id="go" disabled>Iniciar</button>
      <details class="hist" id="hist"><summary>Hoje: <span id="hn">0</span> concluída(s)</summary><ul id="hl"></ul></details>
    </div>`));
    $('#quem').textContent = `Brigada ${u.brigada} · Mec. ${u.nmec}`;
    const lista = $('#lista'), info = $('#info'), go = $('#go'), pedir = $('#pedir'), ords = $('#ords'), bulk = $('#bulk');
    lista.value = draft.lista;
    pedir.checked = GM_getValue('confirmarAntes', true) !== false;
    pedir.addEventListener('change', () => GM_setValue('confirmarAntes', pedir.checked));

    // Histórico do dia (mais recentes primeiro)
    const itens = histLoad().itens;
    $('#hn').textContent = itens.length;
    const hl = $('#hl');
    [...itens].reverse().forEach((i) => {
      const li = document.createElement('li');
      li.textContent = `${i.hora} · ${i.ordem} · ${TIPOS[i.tipo] || i.tipo || ''} · ${i.tarefa}`;
      hl.appendChild(li);
    });

    const refreshInfo = () => {
      const { validas, dup } = parseLista(lista.value);
      const n = validas.length;
      const cont = { ORAC: 0, ORAP: 0, ESC: 0 };
      let sem = 0;
      validas.forEach((o) => { const t = draft.tipos[o.toUpperCase()]; if (cont[t] !== undefined) cont[t]++; else sem++; });
      const partes = [];
      if (n) partes.push(`${n} ${n === 1 ? 'ordem' : 'ordens'}`);
      Object.keys(TIPOS).forEach((t) => { if (cont[t]) partes.push(`${cont[t]} ${TIPOS[t]}`); });
      if (sem) partes.push(`${sem} sem tipo`);
      if (dup) partes.push(`${dup} repetida${dup === 1 ? '' : 's'} ignorada${dup === 1 ? '' : 's'}`);
      info.className = 'info' + (n && !sem ? ' ok' : sem ? ' bad' : '');
      info.textContent = partes.join(' · ');
      go.disabled = !n || sem > 0;
      go.textContent = n > 1 ? `Iniciar (${n} ordens)` : 'Iniciar';
    };

    // "Select all": checkbox no cabeçalho da lista, alinhada com as checkboxes "Contrato antigo" das linhas
    let selAll = null;
    const refreshAllOld = () => {
      if (!selAll) return;
      const { validas } = parseLista(lista.value);
      selAll.checked = validas.length > 0 && validas.every((o) => draft.antigo[o.toUpperCase()]);
    };

    const renderLinhas = () => {
      const { validas } = parseLista(lista.value);
      bulk.hidden = !validas.length;
      ords.hidden = !validas.length;
      ords.replaceChildren();
      if (validas.length) {
        const head = el(`<li class="ord head"><span class="o"></span><span class="tar"></span><label class="old"><input type="checkbox"><span>Select all</span></label></li>`);
        selAll = head.querySelector('input');
        selAll.addEventListener('change', () => {
          const v = selAll.checked;
          validas.forEach((o) => { draft.antigo[o.toUpperCase()] = v; });
          renderLinhas();
        });
        ords.append(head);
      }
      validas.forEach((o, i) => {
        const k = o.toUpperCase();
        const li = el(`<li class="ord"><span class="o"></span><span class="tar"></span><label class="old"><input type="checkbox"><span>Contrato antigo</span></label><span class="seg">${Object.keys(TIPOS).map((t) => `<label class="chip"><input type="radio" name="t${i}" value="${t}"><span>${TIPOS[t]}</span></label>`).join('')}</span></li>`);
        li.querySelector('.o').textContent = o;
        const tar = li.querySelector('.tar');
        const cb = li.querySelector('.old input');
        const mostraTarefa = () => {
          const t = draft.tipos[k];
          tar.textContent = t ? tarefaDe(t, !!draft.antigo[k]) : '';
        };
        if (!draft.tipos[k]) li.classList.add('sem');
        cb.checked = !!draft.antigo[k];
        cb.addEventListener('change', () => { draft.antigo[k] = cb.checked; mostraTarefa(); refreshAllOld(); });
        li.querySelectorAll('.chip input').forEach((r) => {
          r.checked = draft.tipos[k] === r.value;
          r.addEventListener('change', () => { draft.tipos[k] = r.value; li.classList.remove('sem'); mostraTarefa(); refreshInfo(); });
        });
        mostraTarefa();
        ords.append(li);
      });
      refreshAllOld();
      refreshInfo();
    };

    lista.addEventListener('input', () => { draft.lista = lista.value; renderLinhas(); });
    bulk.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-t]');
      if (!b) return;
      parseLista(lista.value).validas.forEach((o) => { draft.tipos[o.toUpperCase()] = b.dataset.t; });
      renderLinhas();
    });
    go.addEventListener('click', () => {
      const { validas } = parseLista(lista.value);
      if (!validas.length) return;
      if (!configurado()) { emConfig = true; lastKey = ''; render(); return; }
      const fila = validas.map((o) => { const k = o.toUpperCase(); const t = draft.tipos[k]; return { ordem: o, tipo: t, tarefa: t ? tarefaDe(t, !!draft.antigo[k]) : undefined }; });
      if (fila.some((f) => !f.tarefa)) return;
      localStorage.removeItem(CFG.reportKey);
      const agora = Date.now();
      save({
        fila, idx: 0, res: [], ordem: fila[0].ordem, tipo: fila[0].tipo, tarefa: fila[0].tarefa,
        confirmar: pedir.checked,
        falhasSeguidas: 0, recargas: 0, inicio: agora, tOrdem: agora, step: 'pesquisa', prog: 0, nota: 'A iniciar…',
      });
      setAberto(true);
      run();
    });
    renderLinhas();
  }

  function viewRun(s) {
    const total = s.fila.length, feitas = s.res.length;
    const ok = s.res.filter((r) => r.estado === 'ok').length;
    const lis = PASSOS.map((t, i) => `<li class="${i < s.prog ? 'done' : i === s.prog ? 'cur' : ''}"><i></i><span>${t}</span></li>`).join('');
    body.append(el(`<div>
      <div class="ordem"><span class="mono" id="ro"></span><span class="tag" id="rt"></span></div>
      <div class="sum" id="rs"></div>
      <div class="bar"><i></i></div>
      <ol class="steps">${lis}</ol>
      <div class="nota"></div>
      <button class="btn ghost" id="stop">Parar e ver relatório</button>
    </div>`));
    $('#ro').textContent = s.ordem;
    $('#rt').textContent = `${TIPOS[s.tipo] || ''} · ${s.tarefa}`;
    $('#rs').textContent = `Ordem ${s.idx + 1} de ${total} · ${ok} ok · ${feitas - ok} com problemas`;
    $('.bar i').style.width = Math.round((feitas / total) * 100) + '%';
    $('.nota').textContent = s.nota || '';
    $('#stop').addEventListener('click', () => { if (pendingConfirm) { pendingConfirm.res(false); pendingConfirm = null; } finalizar('Parado por ti.'); });
  }

  function viewConfirm() {
    const r = pendingConfirm.resumo;
    const dl = Object.entries(r).map(([k]) => `<dt>${k}</dt><dd></dd>`).join('');
    const node = el(`<div><div class="lbl">Confirma antes de submeter</div><dl>${dl}</dl>
      <div class="row"><button class="btn ghost" id="no">Cancelar</button><button class="btn primary" id="yes">Submeter</button></div></div>`);
    [...node.querySelectorAll('dd')].forEach((d, i) => { d.textContent = Object.values(r)[i]; });
    body.append(node);
    $('#yes').addEventListener('click', () => { const p = pendingConfirm; pendingConfirm = null; lastKey = ''; p.res(true); render(); });
    $('#no').addEventListener('click', () => { const p = pendingConfirm; pendingConfirm = null; lastKey = ''; p.res(false); render(); });
  }

  function viewErro(s) {
    body.append(el(`<div><div class="ordem"><span class="mono" id="eo"></span></div>
      <div class="err"></div>
      <div class="nota">Podes resolver à mão no ecrã e carregar em <b>Continuar</b> (assume este passo como feito), ou tentar de novo com <b>Repetir passo</b>. Podes ainda saltar esta ordem ou terminar e ver o relatório.</div>
      <div class="row">
        <button class="btn primary" id="rep">Repetir passo</button>
        <button class="btn" id="cont">Continuar</button>
      </div>
      <div class="row">
        <button class="btn ghost" id="salt">Saltar ordem</button>
        <button class="btn ghost" id="canc">Terminar</button>
      </div></div>`));
    $('#eo').textContent = `${s.ordem} (${s.idx + 1} de ${s.fila.length})`;
    $('.err').textContent = `Falhou em "${passoAtual(s)}": ${s.erro}`;
    $('#rep').addEventListener('click', repetirPasso);
    $('#cont').addEventListener('click', continuarDepois);
    $('#salt').addEventListener('click', saltarOrdem);
    $('#canc').addEventListener('click', () => finalizar('Terminado por ti depois de um erro.'));
  }

  const ROT = { ok: ['ok', '✓', 'OK'], erro: ['ko', '✗', 'Falhou'], interrompida: ['pa', '■', 'Interrompida'], pend: ['pe', '…', 'Por processar'] };
  const fmtDur = (seg) => (seg >= 60 ? `${Math.floor(seg / 60)} min ${seg % 60} s` : `${seg} s`);

  async function copiar(txt) {
    try { await navigator.clipboard.writeText(txt); return true; } catch (e) { /* tenta o método antigo */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = txt; ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch (e) { return false; }
  }

  function viewDone(rel) {
    const res = rel.res || [];
    const pend = (rel.fila || []).filter((f) => !res.some((r) => r.ordem === f.ordem));
    const ok = res.filter((r) => r.estado === 'ok').length;
    const node = el(`<div>
      <div class="lbl">Relatório</div>
      <div class="sum" id="sum"></div>
      <div class="nota" id="par" hidden></div>
      <ul class="rep"></ul>
      <div class="row">
        <button class="btn" id="copy">Copiar relatório</button>
        <button class="btn primary" id="nova">Nova lista</button>
      </div></div>`);
    body.append(node);
    $('#sum').textContent = `${res.length + pend.length} ordens · ${ok} ok · ${res.length - ok} com problemas · ${pend.length} por processar · ${fmtDur(Math.max(0, Math.round((rel.ts - rel.inicio) / 1000)))}`;
    if (rel.paragem) { const p = $('#par'); p.hidden = false; p.textContent = rel.paragem; }
    const ul = $('.rep');
    const add = (ordem, estado, detalhe) => {
      const [cls, ic] = ROT[estado] || ROT.erro;
      const li = el(`<li class="${cls}"><b>${ic}</b><div><div class="o"></div><div class="n"></div></div></li>`);
      li.querySelector('.o').textContent = ordem;
      li.querySelector('.n').textContent = detalhe;
      ul.append(li);
    };
    const tipoTxt = (x) => (x.tipo ? `${TIPOS[x.tipo] || x.tipo} · ${x.tarefa} — ` : '');
    res.forEach((r) => add(r.ordem, r.estado, tipoTxt(r) + (r.estado === 'ok' ? (r.nota || '') : `${r.passo ? r.passo + ': ' : ''}${r.nota || ''}`)));
    pend.forEach((f) => add(f.ordem, 'pend', tipoTxt(f) + 'Não chegou a ser processada.'));
    $('#copy').addEventListener('click', async (e) => {
      const linhas = [['Ordem', 'Tipo', 'Tarefa', 'Estado', 'Passo', 'Observação', 'Segundos'].join('\t')];
      res.forEach((r) => linhas.push([r.ordem, TIPOS[r.tipo] || '', r.tarefa || '', (ROT[r.estado] || ROT.erro)[2], r.passo || '', String(r.nota || '').replace(/\s+/g, ' '), r.seg ?? ''].join('\t')));
      pend.forEach((f) => linhas.push([f.ordem, TIPOS[f.tipo] || '', f.tarefa || '', ROT.pend[2], '', '', ''].join('\t')));
      const btn = e.currentTarget;
      btn.textContent = (await copiar(linhas.join('\n'))) ? 'Copiado ✓' : 'Não consegui copiar';
      setTimeout(() => { btn.textContent = 'Copiar relatório'; }, 2000);
    });
    $('#nova').addEventListener('click', () => { localStorage.removeItem(CFG.reportKey); lastView = null; lastKey = ''; draft.lista = ''; draft.tipos = {}; draft.antigo = {}; render(); });
  }

  render();
  run();
})();
