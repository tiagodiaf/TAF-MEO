// ==UserScript==
// @name         Nemesis VB – Viabilidade
// @namespace    tiago.nemesis.vb
// @version      1.2.0
// @description  Automatiza o fluxo de viabilidade (ORAP/ORAC): pesquisa, orçamento, recolha e resposta final
// @match        https://nemesis.telecom.pt/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  if (window.top !== window.self) return;

  /* ───────────── Configuração (editar aqui) ───────────── */
  const CFG = {
    brigada: '27/6785',
    nmec: '75086',
    qtd: '1',
    tarefas: { ORAP: 'PJ0203', ORAC: 'PJ0201' },
    respostaValor: '2569',            // "Projeto elaborado (O)"
    descricaoOrcamento: 'Orçamento',
    obsMax: 200,
    confirmarSel: '',                 // seletor (dentro do popup) do botão que confirma a resposta. Vazio = deteção automática
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
  // "Continuar": assume o passo atual como feito à mão e segue para o seguinte
  const NEXT = { pesquisa: 'detalhe', detalhe: 'lista', lista: 'recolha', recolha: 'resposta', resposta: 'fim' };
  const PROG = { detalhe: 0, lista: 1, recolha: 3, resposta: 4, fim: 5 };

  /* ───────────── Página atual ───────────── */
  const P = location.pathname;
  const isTarefas = /BPT_MinhasTarefas\.aspx/i.test(P);
  const isDetalhe = /Orcamento_Detalhe_NEW\.aspx/i.test(P);
  const isLista = /Orcamentos_List\.aspx/i.test(P);
  const isRecolhas = /Recolhas_List\.aspx/i.test(P);

  /* ───────────── Estado (partilhado entre páginas) ───────────── */
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
  track(window);

  // Espera até não haver pedidos pendentes durante um curto período contínuo
  async function waitIdle(win = window, quiet = 350) {
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
  const frameComUrl = (parte) => [...document.querySelectorAll('iframe')].some((f) => (f.src || '').includes(parte));

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
      ['wtWBAddTarefas_wtRecolha_Brigada', CFG.brigada],
      ['wtWBAddTarefas_wtRecolha_Nmec', CFG.nmec],
      ['wtWBAddTarefas_wtRecolha_DataSP', hoje()],
      ['wtWBAddTarefas_wtRecolha_Qtd', CFG.qtd],
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

  function botaoConfirmar(doc) {
    if (CFG.confirmarSel) return doc.querySelector(CFG.confirmarSel);
    const c = [...doc.querySelectorAll('input[type=submit],input[type=button],button,a.BotaoNemesis')]
      .filter((b) => /^(submeter|gravar|confirmar|guardar|enviar|ok)\b/i.test((b.value || b.textContent || '').trim()));
    return c.length === 1 ? c[0] : null;
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

    const ok = await confirmar({
      Ordem: s.ordem,
      Resposta: sel.options[sel.selectedIndex].text,
      Observações: s.obs,
    });
    if (!ok) { clear(); return; }

    patch({ step: 'fim', prog: 5, nota: 'A submeter a resposta…' });
    conf.click();
    let avisado = false;
    await waitFor(() => {
      if (!avisado && frameComUrl('WFDocumentosMandatory')) {
        avisado = true;
        patch({ nota: 'Abriu o popup de documentos obrigatórios. Trata aí; continuo quando a página mudar.' });
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
    // Se não estivermos na página certa para o próximo passo, navega
    const id = s.ordemId;
    if (next === 'lista' && id && !isLista) { location.href = urlLista(id); return; }
    if (next === 'recolha' && id && !isLista && !isRecolhas) { location.href = urlLista(id); return; }
    if (next === 'resposta' && id && !isDetalhe && !isRecolhas) { location.href = urlDetalhe(id); return; }
    run();
  }

  /* ───────────── Interface ───────────── */
  const CSS = `
    :host{all:initial}
    *{box-sizing:border-box;font-family:"Segoe UI",system-ui,sans-serif}
    .fab{position:fixed;right:20px;bottom:20px;z-index:2147483647;width:54px;height:54px;border-radius:50%;border:0;cursor:pointer;
      background:#1f4fd8;color:#fff;font-weight:800;font-size:16px;letter-spacing:.5px;box-shadow:0 6px 18px rgba(31,79,216,.4)}
    .fab:hover{background:#1a43b8}.fab:focus-visible,.btn:focus-visible,.inp:focus-visible,textarea:focus-visible{outline:3px solid #9db6ff;outline-offset:2px}
    .fab[data-s=run]{box-shadow:0 0 0 4px rgba(31,79,216,.25),0 6px 18px rgba(31,79,216,.4)}
    .fab[data-s=err]{background:#c0392b}.fab[data-s=ok]{background:#17825D}
    .panel{position:fixed;right:20px;bottom:84px;z-index:2147483647;width:340px;max-height:80vh;overflow:auto;background:#fff;color:#17202a;
      border:1px solid #d9dee6;border-radius:12px;box-shadow:0 14px 40px rgba(20,30,50,.22);font-size:14px}
    .panel[hidden]{display:none}
    header{display:flex;align-items:center;gap:8px;padding:12px 14px;border-bottom:1px solid #e6e9ef;background:#f3f5f8;border-radius:12px 12px 0 0}
    header strong{font-size:15px}header .sub{color:#667085;font-size:12px;flex:1}
    .x{border:0;background:none;font-size:20px;line-height:1;cursor:pointer;color:#667085}
    .body{padding:14px}
    .lbl{display:block;font-weight:600;margin:12px 0 6px}.lbl:first-child{margin-top:0}
    .inp{width:100%;padding:9px 10px;border:1px solid #c5ccd8;border-radius:8px;font-size:14px}
    .mono{font-family:Consolas,"Courier New",monospace;letter-spacing:.3px}
    .info{min-height:20px;margin-top:6px;font-size:13px;color:#667085}.info.ok{color:#17825D;font-weight:600}.info.bad{color:#b26a00}
    .chips{display:flex;flex-wrap:wrap;gap:6px}.chip input{position:absolute;opacity:0}
    .chip span{display:inline-block;padding:6px 11px;border:1px solid #c5ccd8;border-radius:999px;cursor:pointer;font-size:13px;background:#fff}
    .chip input:checked+span{background:#1f4fd8;border-color:#1f4fd8;color:#fff}
    .chip input:focus-visible+span{outline:3px solid #9db6ff}
    textarea{width:100%;margin-top:8px;padding:9px 10px;border:1px solid #c5ccd8;border-radius:8px;font-size:14px;resize:vertical}
    .cnt{text-align:right;font-size:12px;color:#667085}
    .btn{width:100%;margin-top:14px;padding:10px;border-radius:8px;border:1px solid #c5ccd8;background:#fff;font-size:14px;font-weight:600;cursor:pointer}
    .btn.primary{background:#1f4fd8;border-color:#1f4fd8;color:#fff}.btn.primary:disabled{background:#b7c4ee;border-color:#b7c4ee;cursor:not-allowed}
    .btn.ghost{color:#475467}.row{display:flex;gap:8px}.row .btn{margin-top:14px}
    .ordem{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}
    .tag{background:#eaf0ff;color:#1a43b8;border-radius:6px;padding:2px 8px;font-size:12px;font-weight:600}
    .steps{list-style:none;margin:0;padding:0}
    .steps li{display:flex;align-items:center;gap:10px;padding:6px 0;color:#98a2b3;position:relative}
    .steps li:not(:last-child)::after{content:"";position:absolute;left:8px;top:26px;height:calc(100% - 12px);border-left:2px solid #e1e5ec}
    .steps i{width:18px;height:18px;border-radius:50%;border:2px solid #c5ccd8;background:#fff;flex:none;z-index:1}
    .steps li.done{color:#17202a}.steps li.done i{background:#17825D;border-color:#17825D;box-shadow:inset 0 0 0 3px #fff;}
    .steps li.cur{color:#17202a;font-weight:600}.steps li.cur i{border-color:#1f4fd8;border-top-color:transparent;animation:g 1s linear infinite}
    @keyframes g{to{transform:rotate(360deg)}}
    @media (prefers-reduced-motion:reduce){.steps li.cur i{animation:none;border-top-color:#1f4fd8}}
    .nota{margin-top:10px;padding:9px 10px;background:#f3f5f8;border-radius:8px;font-size:13px;color:#475467}
    .err{padding:10px;background:#fdecea;border:1px solid #f3b8b1;border-radius:8px;color:#8f2a20;font-size:13px;word-break:break-word}
    .okbox{padding:10px;background:#e8f6ef;border:1px solid #a9dcc2;border-radius:8px;color:#0f5a40;font-size:13px}
    dl{margin:0}dt{font-weight:600;margin-top:8px}dd{margin:2px 0 0;word-break:break-word}
    @media (max-width:420px){.panel{right:8px;left:8px;width:auto}}
  `;

  const host = document.createElement('div');
  host.id = 'vb-host';
  document.documentElement.appendChild(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS}</style>
    <button class="fab" title="Viabilidade (VB)">VB</button>
    <section class="panel" hidden>
      <header><strong>Viabilidade</strong><span class="sub">Nemesis</span><button class="x" aria-label="Fechar">×</button></header>
      <div class="body"></div>
    </section>`;
  const $ = (sel, el = root) => el.querySelector(sel);
  const fab = $('.fab'), panel = $('.panel'), body = $('.body');

  let aberto = !!load();
  let lastView = null, lastKey = '';
  let pendingConfirm = null;
  const draft = { ordem: '', obsTipo: OBS_OPCOES[0], obsTexto: '' };

  fab.addEventListener('click', () => { aberto = !aberto; render(); });
  $('.x').addEventListener('click', () => { aberto = false; render(); });
  window.addEventListener('storage', (e) => { if (e.key === CFG.stateKey) { lastKey = ''; render(); } });

  function confirmar(resumo) {
    return new Promise((res) => { pendingConfirm = { resumo, res }; aberto = true; lastKey = ''; render(); });
  }

  function render() {
    const s = load();
    host.style.display = (isTarefas || s) ? '' : 'none';
    panel.hidden = !aberto;
    const v = pendingConfirm ? 'confirm' : !s ? 'form' : s.erro ? 'erro' : s.step === 'concluido' ? 'done' : 'run';
    fab.dataset.s = v === 'run' || v === 'confirm' ? 'run' : v === 'erro' ? 'err' : v === 'done' ? 'ok' : '';
    if (v === 'form' && lastView === 'form') return;
    const key = v + (s ? `${s.prog}|${s.nota}|${s.erro || ''}` : '');
    if (key === lastKey) return;
    lastKey = key; lastView = v;
    body.replaceChildren();
    if (v === 'form') viewForm();
    else if (v === 'confirm') viewConfirm();
    else if (v === 'erro') viewErro(s);
    else if (v === 'done') viewDone(s);
    else viewRun(s);
  }

  function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

  function viewForm() {
    body.append(el(`<div>
      <label class="lbl" for="ordem">Número da ordem</label>
      <input id="ordem" class="inp mono" placeholder="26VB_ORAP_083614" autocomplete="off" spellcheck="false">
      <div class="info" id="info"></div>
      <div class="lbl">Observações da resposta</div>
      <div class="chips" role="radiogroup">
        ${OBS_OPCOES.map((o) => `<label class="chip"><input type="radio" name="obs" value="${o}"><span>${o}</span></label>`).join('')}
        <label class="chip"><input type="radio" name="obs" value="__outro"><span>Outro texto</span></label>
      </div>
      <div id="livre" hidden>
        <textarea id="txt" rows="3" maxlength="${CFG.obsMax}" placeholder="Escreve a observação"></textarea>
        <div class="cnt"><span id="n">0</span>/${CFG.obsMax}</div>
      </div>
      <button class="btn primary" id="go" disabled>Iniciar viabilidade</button>
    </div>`));
    const ordem = $('#ordem'), info = $('#info'), livre = $('#livre'), txt = $('#txt'), go = $('#go');
    ordem.value = draft.ordem; txt.value = draft.obsTexto; $('#n').textContent = txt.value.length;
    root.querySelectorAll('input[name=obs]').forEach((r) => { r.checked = r.value === draft.obsTipo; });

    const parse = () => {
      const o = ordem.value.trim().toUpperCase();
      const m = /^[A-Z0-9]+_(ORAP|ORAC)_\d+$/.exec(o);
      return m ? { ordem: o, tipo: m[1], tarefa: CFG.tarefas[m[1]] } : null;
    };
    const obsFinal = () => (draft.obsTipo === '__outro' ? draft.obsTexto.trim() : draft.obsTipo);
    const refresh = () => {
      const p = parse();
      const raw = ordem.value.trim();
      info.className = 'info' + (p ? ' ok' : raw ? ' bad' : '');
      info.textContent = p ? `${p.tipo} · tarefa ${p.tarefa}` : raw ? 'Formato esperado: 26VB_ORAP_083614 (ORAP ou ORAC)' : '';
      livre.hidden = draft.obsTipo !== '__outro';
      go.disabled = !(p && obsFinal());
    };
    ordem.addEventListener('input', () => { ordem.value = ordem.value.toUpperCase(); draft.ordem = ordem.value; refresh(); });
    root.querySelectorAll('input[name=obs]').forEach((r) => r.addEventListener('change', () => { draft.obsTipo = r.value; refresh(); if (r.value === '__outro') txt.focus(); }));
    txt.addEventListener('input', () => { draft.obsTexto = txt.value; $('#n').textContent = txt.value.length; refresh(); });
    go.addEventListener('click', () => {
      const p = parse(); if (!p) return;
      save({ ...p, obs: obsFinal(), step: 'pesquisa', prog: 0, nota: 'A iniciar…' });
      aberto = true;
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
