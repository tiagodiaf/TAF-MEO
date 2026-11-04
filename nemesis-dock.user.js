// ==UserScript==
// @name         Nemesis Dock
// @namespace    tiago.nemesis.dock
// @version      1.0
// @description  Barra flutuante partilhada pelos scripts Nemesis (VB, CAD, CARCAD_O): ícone, balão, pílulas de estado e posição dos painéis
// @match        https://nemesis.telecom.pt/*
// @run-at       document-idle
// @noframes
// @grant        none
// @updateURL    https://raw.githubusercontent.com/tiagodiaf/nemesis-tarefas/main/nemesis-dock.user.js
// @downloadURL  https://raw.githubusercontent.com/tiagodiaf/nemesis-tarefas/main/nemesis-dock.user.js
// ==/UserScript==

/* ═════════════════════════════════════════════════════════════════════════════
   CONTRATO v1 entre o Dock e os scripts (VB, CAD, CARCAD_O)

   Tudo por DOM e eventos. Os scripts correm isolados (@grant), por isso:
   • todos os eventos são CustomEvent com o "detail" em STRING JSON (objetos e funções não atravessam);
   • não há variáveis nem callbacks partilhados.

   Arranque (a ordem entre scripts não é garantida)
     O Dock cria <div id="nemesis-dock" data-contrato="1"> e, depois, dispara "nemesis-dock:pronto" no document.
     Um script verifica #nemesis-dock[data-contrato] e, se ainda não existir, espera por esse evento.

   Script → Dock (CustomEvent no document; detail = JSON)
     nemesis-dock:registar  {id, nome, versao, ordem}
        Antes de registar, o script cria o host do painel:
        <div data-nd-painel="ID" style="display:none"> (com o seu shadow DOM e o <section class="panel">)
        e põe-no no document.documentElement. O Dock adota-o, e só ele o mostra, esconde e posiciona.
     nemesis-dock:estado    {id, naLista, estado, pilula, contador, progresso, dica, dispensavel}
        Estado completo (substitui o anterior). estado: '' | 'run' | 'err' | 'ok'
        naLista: aparece no balão · pilula: aparece a pílula · contador: texto (ex. "2/6")
        progresso: 0-100 · dica: tooltip da pílula · dispensavel: mostra o ×
     nemesis-dock:abrir     {id}   abre o painel do script (fecha o que estiver aberto)
     nemesis-dock:fechar    {id}
     nemesis-dock:remover   {id}   desregista (item, pílula e painel). Se o host sair do DOM, o Dock limpa sozinho.

   Dock → script (CustomEvent no host do painel do script)
     nemesis-dock:dispensar        clique no × da pílula

   Estabilidade: dentro do contrato 1 só há alterações ADITIVAS (campos/eventos novos opcionais; o que não
   se conhece é ignorado). Uma mudança incompatível passa a data-contrato="2".
   ═════════════════════════════════════════════════════════════════════════════ */

(() => {
  'use strict';

  // ▼ VERSÃO — muda só aqui (e na linha // @version do cabeçalho, que o Tampermonkey não deixa usar variáveis) ▼
  const VERSAO = '1.0';
  if (window.top !== window.self) return;

  const CONTRATO = '1';
  const DOCK_ID = 'nemesis-dock';
  const DOCK_KEY = 'nemesis_dock_pos_v2';   // posição guardada: distância ao canto inferior direito
  const EV = 'nemesis-dock:';
  if (document.getElementById(DOCK_ID)) return;   // já existe (instalado duas vezes)

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  /* ───────────── Estrutura ───────────── */
  const d = document.createElement('div');
  d.id = DOCK_ID;
  d.dataset.contrato = CONTRATO;
  d.dataset.versao = VERSAO;
  d.style.visibility = 'hidden';   // só aparece quando algum script tem algo para mostrar
  const r = d.attachShadow({ mode: 'open' });
  r.innerHTML = `<style>
    :host{all:initial;position:fixed;z-index:2147483647;right:110px;bottom:10px;font-family:"Segoe UI",system-ui,sans-serif}
    *{box-sizing:border-box;font-family:"Segoe UI",system-ui,sans-serif}
    .wrap{position:relative;display:flex;flex-direction:column;align-items:flex-end}
    .row{display:flex;align-items:center;gap:6px}
    .pills{display:flex;align-items:center;gap:6px}
    .grip{width:12px;height:28px;display:flex;align-items:center;justify-content:center;font:700 12px/1 "Segoe UI",system-ui,sans-serif;letter-spacing:-2px;
      color:#98a2b3;cursor:grab;touch-action:none;user-select:none;opacity:0;transition:opacity .15s}
    .wrap:hover .grip,.grip.drag{opacity:1}.grip.drag{cursor:grabbing}
    .ico{width:34px;height:34px;padding:0;display:flex;align-items:center;justify-content:center;border-radius:10px;border:1px solid #d0d5dd;background:#fff;
      color:#475467;cursor:pointer;opacity:.55;transition:opacity .15s,box-shadow .15s}
    .wrap:hover .ico,.wrap.pin .ico,.ico:focus-visible{opacity:1;box-shadow:0 2px 10px rgba(20,30,50,.15)}
    .ico:focus-visible{outline:2px solid #9ca3af;outline-offset:2px}
    .balloon{position:absolute;right:0;bottom:100%;padding-bottom:8px;opacity:0;visibility:hidden;transform:translateY(4px);
      transition:opacity .15s .25s,transform .15s .25s,visibility 0s .4s}
    .wrap:hover .balloon,.wrap.pin .balloon{opacity:1;visibility:visible;transform:none;transition-delay:0s}
    .card{width:250px;padding:6px 0;background:#fff;border:1px solid #d9dee6;border-radius:12px;box-shadow:0 14px 40px rgba(20,30,50,.18)}
    .t{padding:6px 14px 4px;font-size:12px;color:#667085}
    .list{display:flex;flex-direction:column}
    :host([data-run]) .ico,:host([data-run]) .balloon,:host([data-panel]) .balloon{display:none}
    @media (prefers-reduced-motion:reduce){.balloon,.ico,.grip{transition:none}}

    /* item no balão */
    .item{display:flex;align-items:center;gap:10px;width:calc(100% - 8px);margin:2px 4px;padding:9px 10px;border:0;border-radius:8px;background:none;cursor:pointer;
      font-size:13px;color:#17202a;text-align:left}
    .item:hover{background:#f2f4f7}
    .item:focus-visible{outline:2px solid #9ca3af}
    .dot{width:7px;height:7px;border-radius:50%;background:#c5ccd8;flex:none}
    .item[data-s=ok] .dot{background:#17825D}.item[data-s=err] .dot{background:#c0392b}
    .nm{flex:1;font-weight:600}
    small{font-size:11px;color:#98a2b3}
    .item svg{color:#98a2b3;flex:none}

    /* pílula */
    .pill{position:relative;display:flex;align-items:center;gap:8px;height:34px;padding:0 12px;border-radius:17px;border:1px solid #d0d5dd;background:#fff;color:#17202a;
      font-size:13px;font-weight:600;cursor:pointer;user-select:none;white-space:nowrap;overflow:hidden;box-shadow:0 2px 10px rgba(20,30,50,.12)}
    .pill[hidden]{display:none}
    .pill:hover{border-color:#98a2b3}
    .pill:focus-visible{outline:2px solid #9ca3af;outline-offset:2px}
    .pi{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;flex:none;font-size:14px;line-height:1}
    .pill[data-s=run] .pi{width:12px;height:12px;border:2px solid #1f2937;border-top-color:transparent;border-radius:50%;animation:g 1s linear infinite}
    .pill[data-s=err] .pi::before{content:"!";color:#c0392b}
    .pill[data-s=ok] .pi::before{content:"✓";color:#17825D}
    .pn{color:#667085}.pill[data-s=err] .pn{color:#c0392b}.pill[data-s=ok] .pn{color:#17825D}
    .pg{position:absolute;left:0;bottom:0;height:2px;background:#1f2937;transition:width .3s}
    .pd{border:0;background:none;color:#98a2b3;font-size:16px;line-height:1;cursor:pointer;padding:0 0 0 2px}.pd:hover{color:#17202a}.pd[hidden]{display:none}
    @keyframes g{to{transform:rotate(360deg)}}
    @media (prefers-reduced-motion:reduce){.pill[data-s=run] .pi{animation:none}}

    /* painel (o conteúdo é do script; o Dock só o posiciona) */
    .pnl{position:fixed;left:0;top:0;width:max-content;z-index:2147483647}
    .pnl[hidden]{display:none}
  </style>
  <div class="wrap">
    <div class="balloon"><div class="card"><div class="t">Scripts Nemesis</div><div class="list"></div></div></div>
    <div class="row"><span class="grip" title="Arrastar (duplo clique repõe a posição)">⋮⋮</span><div class="pills"></div>
      <button class="ico" title="Scripts Nemesis" aria-label="Scripts Nemesis"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2" y="2" width="6" height="6" rx="1.6"/><rect x="10" y="2" width="6" height="6" rx="1.6"/><rect x="2" y="10" width="6" height="6" rx="1.6"/><rect x="10" y="10" width="6" height="6" rx="1.6"/></svg></button></div>
  </div>
  <div class="pnl" hidden><slot name="painel"></slot></div>`;

  const $ = (sel) => r.querySelector(sel);
  const wrap = $('.wrap'), grip = $('.grip'), ico = $('.ico'), list = $('.list'), pills = $('.pills'), pnl = $('.pnl');

  /* ───────────── Posição do painel (junto ao ícone) ───────────── */
  function placePanel() {
    if (pnl.hidden) return;
    const b = d.getBoundingClientRect();
    const pw = pnl.offsetWidth, ph = pnl.offsetHeight;
    const vw = window.innerWidth, vh = window.innerHeight;
    const left = clamp(b.right - pw, 8, Math.max(8, vw - pw - 8));
    let top = b.top - ph - 8;                      // por cima do ícone, ou por baixo se não houver espaço
    if (top < 8) top = b.bottom + 8;
    top = clamp(top, 8, Math.max(8, vh - ph - 8));
    pnl.style.left = left + 'px';
    pnl.style.top = top + 'px';
  }

  /* ───────────── Registos ───────────── */
  const regs = new Map();   // id → {id, nome, versao, ordem, host, item, pill, pn, pg, pd, e, sig}
  let aberto = null;        // id do painel aberto (só um de cada vez)
  let correndo = null;      // id do script cuja pílula "a executar" é a visível

  const SETA = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M5 2l5 5-5 5"/></svg>';
  const alternar = (id) => { aberto = aberto === id ? null : id; render(); };

  function criarItem(g) {
    const b = document.createElement('button');
    b.className = 'item';
    b.title = `${g.nome} v${g.versao}`;
    b.innerHTML = `<span class="dot"></span><span class="nm"></span><small></small>${SETA}`;
    b.querySelector('.nm').textContent = g.nome;
    b.querySelector('small').textContent = g.versao ? 'v' + g.versao : '';
    b.style.order = String(g.ordem);
    b.addEventListener('click', (e) => { e.currentTarget.blur(); alternar(g.id); });
    return b;
  }

  function criarPilula(g) {
    const p = document.createElement('div');
    p.className = 'pill';
    p.setAttribute('role', 'button');
    p.tabIndex = 0;
    p.hidden = true;
    p.innerHTML = '<span class="pi"></span><span class="tn"></span><span class="pn"></span><button class="pd" title="Dispensar" aria-label="Dispensar" hidden>×</button><span class="pg"></span>';
    p.querySelector('.tn').textContent = g.nome;
    p.style.order = String(g.ordem);
    p.addEventListener('click', () => alternar(g.id));
    p.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); alternar(g.id); } });
    g.pn = p.querySelector('.pn'); g.pg = p.querySelector('.pg'); g.pd = p.querySelector('.pd');
    g.pd.addEventListener('click', (e) => {
      e.stopPropagation();
      if (g.host) g.host.dispatchEvent(new CustomEvent(EV + 'dispensar'));
    });
    return p;
  }

  function remover(id) {
    const g = regs.get(id);
    if (!g) return;
    g.item.remove();
    g.pill.remove();
    if (g.host && g.host.parentNode === d) g.host.remove();
    regs.delete(id);
    if (aberto === id) aberto = null;
    if (correndo === id) correndo = null;
    render();
  }

  function registar(m) {
    if (!m || typeof m.id !== 'string' || !/^[\w-]+$/.test(m.id)) return;
    if (regs.has(m.id)) remover(m.id);   // re-registo: recomeça limpo
    const g = {
      id: m.id,
      nome: String(m.nome || m.id),
      versao: String(m.versao || ''),
      ordem: Number(m.ordem) || 99,
      host: null,
      e: { estado: '', naLista: false, pilula: false, contador: '', progresso: 0, dica: '', dispensavel: false },
      sig: '',
    };
    const host = document.querySelector(`[data-nd-painel="${m.id}"]`);
    if (host) {
      host.slot = 'painel';
      host.style.display = 'none';
      d.appendChild(host);
      g.host = host;
    }
    g.item = criarItem(g);
    g.pill = criarPilula(g);
    list.appendChild(g.item);
    pills.appendChild(g.pill);
    regs.set(g.id, g);
    render();
  }

  function estado(m) {
    const g = m && regs.get(m.id);
    if (!g) return;
    const e = {
      estado: ['run', 'err', 'ok'].includes(m.estado) ? m.estado : '',
      naLista: !!m.naLista,
      pilula: !!m.pilula,
      contador: String(m.contador == null ? '' : m.contador),
      progresso: clamp(Number(m.progresso) || 0, 0, 100),
      dica: String(m.dica == null ? '' : m.dica),
      dispensavel: !!m.dispensavel,
    };
    const sig = JSON.stringify(e);
    if (sig === g.sig) return;
    const antes = g.e.estado;
    g.sig = sig;
    g.e = e;
    if (e.estado === 'run' && antes !== 'run') correndo = g.id;   // o que arrancou por último fica visível
    render();
  }

  function render() {
    const todos = [...regs.values()];
    const run = todos.find((g) => g.id === correndo && g.e.estado === 'run') || todos.find((g) => g.e.estado === 'run') || null;
    correndo = run ? run.id : null;
    let algum = false;
    for (const g of todos) {
      const e = g.e;
      if (e.naLista) algum = true;
      g.item.style.display = e.naLista ? '' : 'none';
      g.item.dataset.s = e.estado;
      g.pill.dataset.s = e.estado;
      g.pill.hidden = !e.estado || !e.pilula || (!!run && run.id !== g.id);   // a executar → só a pílula dele
      g.pn.textContent = e.contador;
      g.pg.style.width = e.progresso + '%';
      g.pill.title = e.dica;
      g.pd.hidden = !e.dispensavel;
      if (g.host) g.host.style.display = aberto === g.id ? '' : 'none';
    }
    d.style.visibility = algum ? '' : 'hidden';
    if (run) d.dataset.run = run.id; else delete d.dataset.run;
    if (aberto) d.dataset.panel = aberto; else delete d.dataset.panel;
    pnl.hidden = !(aberto && regs.get(aberto) && regs.get(aberto).host);
    placePanel();
  }

  // Limpeza: se um script retirar o seu host do DOM, é como se se desregistasse
  new MutationObserver((recs) => {
    for (const rec of recs) {
      for (const n of rec.removedNodes) {
        for (const g of [...regs.values()]) if (g.host === n && !n.isConnected) remover(g.id);
      }
    }
  }).observe(d, { childList: true });

  /* ───────────── Mensagens dos scripts ───────────── */
  const on = (nome, fn) => document.addEventListener(EV + nome, (e) => {
    let m = null;
    try { m = JSON.parse(e.detail); } catch (_) { return; }
    try { fn(m || {}); } catch (err) { console.error('[Nemesis Dock]', err); }
  });
  on('registar', registar);
  on('estado', estado);
  on('abrir', (m) => { if (regs.has(m.id)) { aberto = m.id; render(); } });
  on('fechar', (m) => { if (aberto === m.id) { aberto = null; render(); } });
  on('remover', (m) => remover(m.id));

  /* ───────────── Ícone, balão e arrastar ───────────── */
  ico.addEventListener('click', () => wrap.classList.toggle('pin'));
  $('.balloon').addEventListener('click', () => wrap.classList.remove('pin'));
  document.addEventListener('click', (e) => { if (!e.composedPath().includes(d)) wrap.classList.remove('pin'); });

  let cur = null, g0 = null;
  const vp = () => ({ w: document.documentElement.clientWidth, h: document.documentElement.clientHeight });
  const guardada = () => { try { return JSON.parse(localStorage.getItem(DOCK_KEY) || 'null'); } catch (e) { return null; } };
  // A posição guarda-se como distância ao canto inferior direito, para a barra crescer para a esquerda
  const setPos = (rr, bb) => {
    const v = vp();
    cur = { r: clamp(rr, 0, Math.max(0, v.w - d.offsetWidth)), b: clamp(bb, 0, Math.max(0, v.h - d.offsetHeight)) };
    d.style.right = cur.r + 'px'; d.style.bottom = cur.b + 'px';
    placePanel();
  };
  const place = () => {
    const p = guardada();
    if (p && typeof p.r === 'number' && typeof p.b === 'number') setPos(p.r, p.b);
    else { d.style.right = ''; d.style.bottom = ''; placePanel(); }
  };
  grip.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const b = d.getBoundingClientRect(), v = vp();
    g0 = { sx: e.clientX, sy: e.clientY, r0: v.w - b.right, b0: v.h - b.bottom };
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('drag');
  });
  grip.addEventListener('pointermove', (e) => { if (g0) setPos(g0.r0 - (e.clientX - g0.sx), g0.b0 - (e.clientY - g0.sy)); });
  grip.addEventListener('pointerup', (e) => {
    if (!g0) return;
    g0 = null;
    grip.classList.remove('drag');
    try { grip.releasePointerCapture(e.pointerId); } catch (_) { /* ignorar */ }
    if (cur) { try { localStorage.setItem(DOCK_KEY, JSON.stringify(cur)); } catch (_) { /* ignorar */ } }
  });
  grip.addEventListener('dblclick', () => { try { localStorage.removeItem(DOCK_KEY); } catch (_) { /* ignorar */ } place(); });

  document.documentElement.appendChild(d);
  place();
  window.addEventListener('resize', place);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(place).observe(d);
    new ResizeObserver(placePanel).observe(pnl);
  }

  // Pronto: os scripts que já estavam à espera avançam
  document.dispatchEvent(new CustomEvent(EV + 'pronto'));
})();
