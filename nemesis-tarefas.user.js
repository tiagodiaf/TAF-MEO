// ==UserScript==
// @name         Nemesis Tarefas
// @namespace    https://github.com/tiagodiaf/TAF-MEO/
// @version      1.8
// @updateURL    https://github.com/tiagodiaf/TAF-MEO/raw/refs/heads/main/nemesis-tarefas.user.js
// @downloadURL  https://github.com/tiagodiaf/TAF-MEO/raw/refs/heads/main/nemesis-tarefas.user.js
// @description  Preenchimento otimizado de tarefas no Nemesis
// @author       Tiago Afonso
// @match        https://nemesis.telecom.pt/Nemesis_v5/Recolhas.Recolhas_List.aspx*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      gist.githubusercontent.com
// ==/UserScript==

(function () {
  'use strict';

  const VERSAO_SCRIPT = "1.8";
  const GIST_URL = "https://gist.githubusercontent.com/tiagodiaf/611272ebb7015a7d3c7a6f12c2c1d0a6/raw/nemesis-tarefas.json?v=" + Date.now();
  const ID_NUM_MECANO       = 'wtWBAddTarefas_wtRecolha_Nmec';
  const ID_INPUT_TAREFA     = 'wtWBAddTarefas_wtInputTarefa';
  const ID_QUANTIDADE       = 'wtWBAddTarefas_wtRecolha_Qtd';
  const ID_BRIGADA          = 'wtWBAddTarefas_wtRecolha_Brigada';
  const ID_DATA             = 'wtWBAddTarefas_wtRecolha_DataSP';
  const ID_BTN_ADICIONAR    = 'wtWBAddTarefas_wtimg_nova_tarefa';

  // ── Tempos ajustáveis (ms) ─────────────────────────────────────────────
  // ✅ OTIMIZAÇÃO: onde antes havia setTimeout fixos, passa a usar polling
  // (waitFor) que avança assim que a condição é verdadeira, em vez de
  // esperar sempre o tempo máximo. Os valores de "timeout" abaixo são o
  // limite de segurança, não o tempo real de espera normal.
  const T_ESPERA_ABRIR_FORM     = { interval: 80,  timeout: 2500 }; // form a abrir
  const T_ESPERA_APOS_CODIGO    = 350;  // antes: 600ms fixo
  const T_ESPERA_ANTES_CLICAR   = 220;  // antes: 400ms fixo
  const T_POLL_CONFIRMACAO      = { interval: 100, timeout: 3000 }; // antes: 150/4000
  const T_ENTRE_TAREFAS         = 250;  // antes: 600ms fixo

  let tarefas = [];
  let fabEl = null;
  const CACHE_KEY = 'tarefasCache';

  // ── Helpers de estilo (evita repetir os mesmos objetos por todo o lado) ──
  function estiloInputTexto(overrides) {
    return Object.assign({
      padding: '6px 8px', border: '1px solid #b3d4f5',
      borderRadius: '4px', fontSize: '13px', boxSizing: 'border-box'
    }, overrides || {});
  }

  function estiloBotao(bg, cor, overrides) {
    return Object.assign({
      padding: '8px', cursor: 'pointer', backgroundColor: bg, color: cor,
      border: 'none', borderRadius: '4px', fontWeight: 'bold', fontSize: '13px'
    }, overrides || {});
  }

  // ── Helper genérico de polling ────────────────────────────────────────
  function waitFor(conditionFn, callback, opts) {
    var interval = (opts && opts.interval) || 100;
    var timeout = (opts && opts.timeout) || 3000;
    if (conditionFn()) { callback(true); return; }
    var elapsed = 0;
    var poll = setInterval(function () {
      elapsed += interval;
      if (conditionFn()) {
        clearInterval(poll);
        callback(true);
      } else if (elapsed >= timeout) {
        clearInterval(poll);
        callback(false);
      }
    }, interval);
  }

  function carregarTarefas(cb) {
    GM_xmlhttpRequest({
      method: 'GET',
      url: GIST_URL,
      onload: function (r) {
        try {
          const data = JSON.parse(r.responseText);
          GM_setValue(CACHE_KEY, JSON.stringify(data)); // ✅ atualiza cache local
          cb(data, null);
        } catch (e) {
          console.error("Erro no JSON:", e);
          cb([], 'Erro ao ler a lista de tarefas.');
        }
      },
      onerror: function (err) {
        console.error("Erro de rede:", err);
        cb([], 'Sem acesso à lista de tarefas.');
      }
    });
  }

  function showToast(msg, erro) {
    var t = document.createElement('div');
    t.innerText = msg;
    Object.assign(t.style, {
      position: 'fixed', bottom: '20px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '10003', backgroundColor: erro ? '#c62828' : '#2e7d32',
      color: '#fff', padding: '10px 22px', borderRadius: '6px', fontWeight: 'bold',
      fontSize: '13px', boxShadow: '0 2px 8px rgba(0,0,0,0.35)',
      whiteSpace: 'nowrap', opacity: '1', transition: 'opacity 0.5s',
      fontFamily: 'Segoe UI,Arial,sans-serif'
    });
    document.body.appendChild(t);
    setTimeout(function () { t.style.opacity = '0'; }, 1800);
    setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 2400);
  }

  // ── Estados visuais do ícone T (substitui os toasts de sucesso) ────────
  function injetarEstilos() {
    if (document.getElementById('nm-style')) return;
    var s = document.createElement('style');
    s.id = 'nm-style';
    s.textContent =
      '@keyframes nm-pulse {' +
      '  0%, 100% { outline-color: rgba(255,193,7,1); }' +
      '  50% { outline-color: rgba(255,193,7,0.25); }' +
      '}' +
      '#nm-fab.nm-running {' +
      '  outline: 3px solid #ffc107;' +
      '  outline-offset: 3px;' +
      '  animation: nm-pulse 0.9s ease-in-out infinite;' +
      '}' +
      '#nm-fab.nm-success {' +
      '  outline: 3px solid #2e7d32;' +
      '  outline-offset: 3px;' +
      '  animation: none;' +
      '}';
    document.head.appendChild(s);
  }

  function fabRunning() {
    if (!fabEl) return;
    fabEl.classList.remove('nm-success');
    fabEl.classList.add('nm-running');
  }

  function fabSuccess() {
    if (!fabEl) return;
    fabEl.classList.remove('nm-running');
    fabEl.classList.add('nm-success');
    setTimeout(function () {
      if (fabEl) fabEl.classList.remove('nm-success');
    }, 2200);
  }

  function fabIdle() {
    if (!fabEl) return;
    fabEl.classList.remove('nm-running', 'nm-success');
  }

  function abrirDefinicoes() {
    var ex = document.getElementById('nm-settings');
    if (ex) { ex.remove(); return; }

    var panel = document.createElement('div');
    panel.id = 'nm-settings';

    var fab = document.getElementById('nm-fab');
    var rect = fab.getBoundingClientRect();
    Object.assign(panel.style, {
      position: 'fixed',
      top: (rect.top - 10) + 'px',
      left: (rect.right + 10) + 'px',
      zIndex: '10002', backgroundColor: '#fff', border: '2px solid #555',
      padding: '14px', borderRadius: '8px', boxShadow: '0 4px 15px rgba(0,0,0,0.3)',
      fontFamily: 'Segoe UI,Arial,sans-serif', minWidth: '240px'
    });

    var titulo = document.createElement('div');
    titulo.innerText = '⚙ Definições';
    Object.assign(titulo.style, { fontWeight: 'bold', color: '#555', marginBottom: '12px', fontSize: '14px' });
    panel.appendChild(titulo);

    function addField(label, key, placeholder) {
      var wrap = document.createElement('div');
      wrap.style.marginBottom = '10px';
      var lbl = document.createElement('label');
      lbl.innerText = label;
      lbl.style.cssText = 'display:block;font-size:12px;color:#555;margin-bottom:3px;font-weight:bold';
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.value = GM_getValue(key, '');
      inp.placeholder = placeholder;
      inp.dataset.key = key;
      Object.assign(inp.style, estiloInputTexto({ width: '100%', border: '1px solid #ccc' }));
      wrap.appendChild(lbl);
      wrap.appendChild(inp);
      panel.appendChild(wrap);
    }

    addField('Brigada', 'brigada', 'ex: 27/6785');
    addField('Número Mecânico', 'numMecano', 'ex: 75086');

    var btnGuardar = document.createElement('button');
    btnGuardar.innerText = '💾 Guardar';
    Object.assign(btnGuardar.style, estiloBotao('#555', '#fff', { width: '100%' }));
    btnGuardar.onclick = function () {
      panel.querySelectorAll('input[data-key]').forEach(function (inp) {
        GM_setValue(inp.dataset.key, inp.value.trim());
      });
      showToast('✓ Definições guardadas', false);
      panel.remove();
    };
    panel.appendChild(btnGuardar);
    document.body.appendChild(panel);
  }

  // ── Menu principal com multi-seleção ──────────────────────────────────────
  function abrirMenu(erro) {
    var ex = document.getElementById('nm-menu');
    if (ex) { ex.remove(); return; }

    var menu = document.createElement('div');
    menu.id = 'nm-menu';

    var fab = document.getElementById('nm-fab');
    var rect = fab.getBoundingClientRect();
    Object.assign(menu.style, {
      position: 'fixed',
      top: '50%',
      left: (rect.right + 10) + 'px',
      transform: 'translateY(-50%)',
      zIndex: '10002', backgroundColor: '#fff', border: '2px solid #0078d7',
      padding: '12px', borderRadius: '8px', boxShadow: '0 4px 15px rgba(0,0,0,0.3)',
      display: 'flex', flexDirection: 'column', gap: '6px',
      minWidth: '400px', maxWidth: '520px',
      maxHeight: '85vh', overflowY: 'auto',
      fontFamily: 'Segoe UI,Arial,sans-serif'
    });

    // Cabeçalho
    var hdr = document.createElement('div');
    Object.assign(hdr.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' });
    var tit = document.createElement('span');
    tit.innerText = 'Selecionar Tarefas';
    Object.assign(tit.style, { fontWeight: 'bold', color: '#0078d7', fontSize: '14px' });
    var acoes = document.createElement('div');
    var btnCfg = document.createElement('button');
    btnCfg.innerText = '⚙';
    btnCfg.title = 'Definições';
    Object.assign(btnCfg.style, { border: 'none', background: 'none', cursor: 'pointer', fontSize: '15px', color: '#888', marginRight: '4px' });
    btnCfg.onclick = function (e) { e.stopPropagation(); abrirDefinicoes(); };
    var btnX = document.createElement('button');
    btnX.innerText = '✕';
    Object.assign(btnX.style, { border: 'none', background: 'none', cursor: 'pointer', fontSize: '15px', color: '#888' });
    btnX.onclick = function () { menu.remove(); };
    acoes.appendChild(btnCfg);
    acoes.appendChild(btnX);
    hdr.appendChild(tit);
    hdr.appendChild(acoes);
    menu.appendChild(hdr);

    // ✅ Repetir última sequência — mostra sempre um ecrã de confirmação antes de correr
    var ultimaSeqBruta = GM_getValue('ultimaSequencia', null);
    if (ultimaSeqBruta) {
      try {
        var ultimaSeq = JSON.parse(ultimaSeqBruta);
        if (ultimaSeq && ultimaSeq.length) {
          var btnRepetir = document.createElement('button');
          btnRepetir.innerText = '🔁 Repetir última sequência (' + ultimaSeq.length + ')';
          Object.assign(btnRepetir.style, estiloBotao('#eceff1', '#455a64', { marginBottom: '6px', fontSize: '12px' }));
          btnRepetir.onclick = function () {
            var exMenu = document.getElementById('nm-menu');
            if (exMenu) exMenu.remove();
            mostrarConfirmacaoExecucao(ultimaSeq);
          };
          menu.appendChild(btnRepetir);
        }
      } catch (e) { /* ignora cache inválida */ }
    }

    // ── Barra de tabs: Tarefas / Combos ───────────────────────────────────
    var tabBar = document.createElement('div');
    Object.assign(tabBar.style, { display: 'flex', gap: '4px', marginBottom: '6px' });

    var btnTabTarefas = document.createElement('button');
    btnTabTarefas.innerText = '📋 Tarefas';
    var btnTabCombos = document.createElement('button');
    btnTabCombos.innerText = '⭐ Combos';

    var abaTarefas = document.createElement('div');
    var abaCombos = document.createElement('div');
    abaCombos.style.display = 'none';

    function ativarTab(nome) {
      var ativo = estiloBotao('#0078d7', '#fff', { flex: '1', fontSize: '12px', padding: '6px' });
      var inativo = estiloBotao('#f0f0f0', '#666', { flex: '1', fontSize: '12px', padding: '6px' });
      if (nome === 'tarefas') {
        Object.assign(btnTabTarefas.style, ativo);
        Object.assign(btnTabCombos.style, inativo);
        abaTarefas.style.display = 'block';
        abaCombos.style.display = 'none';
      } else {
        Object.assign(btnTabTarefas.style, inativo);
        Object.assign(btnTabCombos.style, ativo);
        abaTarefas.style.display = 'none';
        abaCombos.style.display = 'block';
        renderizarAbaCombos(abaCombos);
      }
    }
    btnTabTarefas.onclick = function () { ativarTab('tarefas'); };
    btnTabCombos.onclick = function () { ativarTab('combos'); };

    tabBar.appendChild(btnTabTarefas);
    tabBar.appendChild(btnTabCombos);
    menu.appendChild(tabBar);
    menu.appendChild(abaTarefas);
    menu.appendChild(abaCombos);

    // Área de scroll para as tarefas
    var listaWrap = document.createElement('div');
    listaWrap.id = 'nm-lista-tarefas';
    Object.assign(listaWrap.style, {
      maxHeight: '420px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px'
    });
    preencherListaWrap(listaWrap, erro);
    abaTarefas.appendChild(listaWrap);

    var hr = document.createElement('hr');
    Object.assign(hr.style, { margin: '4px 0', border: 'none', borderTop: '1px solid #ddd' });
    abaTarefas.appendChild(hr);

    // Linha manual
    var rowManual = document.createElement('div');
    Object.assign(rowManual.style, { display: 'flex', gap: '6px', alignItems: 'center' });
    var inpCod = document.createElement('input');
    inpCod.type = 'text';
    inpCod.placeholder = 'Código manual (ex: P0999)';
    Object.assign(inpCod.style, estiloInputTexto({ flex: '1' }));
    var inpQtdManual = document.createElement('input');
    inpQtdManual.type = 'number';
    inpQtdManual.value = '1';
    inpQtdManual.min = '1';
    inpQtdManual.title = 'Quantidade';
    Object.assign(inpQtdManual.style, estiloInputTexto({ width: '52px', padding: '6px 4px', textAlign: 'center' }));
    var btnOk = document.createElement('button');
    btnOk.innerText = '▶';
    Object.assign(btnOk.style, estiloBotao('#546e7a', '#fff', { padding: '6px 14px' }));
    btnOk.onclick = function () {
      if (inpCod.value.trim()) {
        menu.remove();
        executarSequencia([{ cod: inpCod.value.trim(), qty: parseInt(inpQtdManual.value, 10) || 1 }]);
      }
    };
    inpCod.onkeydown = function (e) {
      if (e.key === 'Enter' && this.value.trim()) {
        menu.remove();
        executarSequencia([{ cod: this.value.trim(), qty: parseInt(inpQtdManual.value, 10) || 1 }]);
      }
    };
    rowManual.appendChild(inpCod);
    rowManual.appendChild(inpQtdManual);
    rowManual.appendChild(btnOk);
    abaTarefas.appendChild(rowManual);

    // Linha de data — checkbox "usar data de hoje" + input de data (valores reutilizados entre execuções)
    var rowData = document.createElement('div');
    Object.assign(rowData.style, { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '12px' });

    var cbHoje = document.createElement('input');
    cbHoje.type = 'checkbox';
    cbHoje.id = 'nm-cb-hoje';
    cbHoje.checked = GM_getValue('usarDataHoje', true);
    Object.assign(cbHoje.style, { cursor: 'pointer', flexShrink: '0', width: '15px', height: '15px' });

    var lblHoje = document.createElement('label');
    lblHoje.innerText = 'Usar data de hoje';
    lblHoje.htmlFor = 'nm-cb-hoje';
    Object.assign(lblHoje.style, { fontSize: '12px', color: '#555', cursor: 'pointer' });

    var inpData = document.createElement('input');
    inpData.type = 'date';
    inpData.value = GM_getValue('dataEscolhida', new Date().toISOString().split('T')[0]);
    Object.assign(inpData.style, {
      padding: '5px 6px', border: '1px solid #b3d4f5', borderRadius: '4px',
      fontSize: '12px', marginLeft: 'auto',
      display: cbHoje.checked ? 'none' : 'block'
    });

    cbHoje.onchange = function () {
      GM_setValue('usarDataHoje', cbHoje.checked);
      inpData.style.display = cbHoje.checked ? 'none' : 'block';
    };
    inpData.onchange = function () {
      GM_setValue('dataEscolhida', inpData.value);
    };

    rowData.appendChild(cbHoje);
    rowData.appendChild(lblHoje);
    rowData.appendChild(inpData);
    abaTarefas.appendChild(rowData);

    // Botão "Executar selecionadas"
    var btnExecutar = document.createElement('button');
    btnExecutar.id = 'nm-btn-executar';
    btnExecutar.innerText = 'Executar tarefas selecionadas';
    Object.assign(btnExecutar.style, estiloBotao('#e0e0e0', '#999', { marginTop: '2px' }));
    btnExecutar.disabled = true;
    btnExecutar.onclick = function () {
      var selecionadas = recolherSelecionadas();
      if (!selecionadas.length) return;
      menu.remove();
      executarSequencia(selecionadas);
    };
    abaTarefas.appendChild(btnExecutar);

    // Versão
    var vText = document.createElement('div');
    vText.innerText = 'v' + VERSAO_SCRIPT;
    Object.assign(vText.style, { fontSize: '9px', color: '#bbb', textAlign: 'right', marginTop: '2px' });
    menu.appendChild(vText);

    document.body.appendChild(menu);
    ativarTab('tarefas');
    inpCod.focus();

    // Actualizar estado do botão executar
    function atualizarBtnExecutar() {
      var selecionadas = recolherSelecionadas();
      var n = selecionadas.length;
      if (n > 0) {
        btnExecutar.disabled = false;
        btnExecutar.innerText = 'Executar ' + n + ' tarefa' + (n > 1 ? 's' : '') + ' selecionada' + (n > 1 ? 's' : '');
        Object.assign(btnExecutar.style, { backgroundColor: '#0078d7', color: '#fff' });
      } else {
        btnExecutar.disabled = true;
        btnExecutar.innerText = 'Executar tarefas selecionadas';
        Object.assign(btnExecutar.style, { backgroundColor: '#e0e0e0', color: '#999' });
      }
    }

    // Expor função para as linhas chamarem
    menu._atualizarBtnExecutar = atualizarBtnExecutar;
  }

  // Preenche a área de lista com as tarefas atuais (ou mensagem de erro)
  function preencherListaWrap(listaWrap, erro) {
    listaWrap.innerHTML = '';
    if (erro) {
      var msgErro = document.createElement('div');
      msgErro.innerText = '⚠ ' + erro;
      Object.assign(msgErro.style, {
        padding: '10px', backgroundColor: '#fff3e0', border: '1px solid #ffb74d',
        borderRadius: '4px', color: '#e65100', fontSize: '13px', textAlign: 'center'
      });
      listaWrap.appendChild(msgErro);
    } else {
      tarefas.forEach(function (t) {
        listaWrap.appendChild(criarLinhaMultiSelect(t));
      });
    }
  }

  // ✅ Refresca a lista do menu já aberto (usado quando a cache é substituída
  // pela resposta de rede), preservando a seleção/quantidades que já lá estavam
  function atualizarListaMenu(erro) {
    var menu = document.getElementById('nm-menu');
    if (!menu) return;
    var listaWrap = menu.querySelector('#nm-lista-tarefas');
    if (!listaWrap) return;

    var selecaoAtual = {};
    recolherSelecionadas().forEach(function (item) { selecaoAtual[item.cod] = item.qty; });

    preencherListaWrap(listaWrap, erro);

    if (!erro) {
      Array.prototype.forEach.call(listaWrap.children, function (row) {
        var cb = row.querySelector && row.querySelector('input[type="checkbox"][data-cod]');
        if (cb && selecaoAtual.hasOwnProperty(cb.dataset.cod) && row._selecionar) {
          row._selecionar(true);
          var qtdInp = row.querySelector('input[data-qtd]');
          if (qtdInp) qtdInp.value = selecaoAtual[cb.dataset.cod];
        }
      });
    }

    if (menu._atualizarBtnExecutar) menu._atualizarBtnExecutar();
  }

  // ── Combos (grupos de tarefas guardados pelo utilizador) ───────────────
  function obterCombos() {
    try { return JSON.parse(GM_getValue('combos', '[]')); } catch (e) { return []; }
  }
  function guardarCombos(lista) {
    GM_setValue('combos', JSON.stringify(lista));
  }

  function renderizarAbaCombos(container) {
    container.innerHTML = '';

    var btnCriar = document.createElement('button');
    btnCriar.innerText = '💾 Guardar seleção atual da aba Tarefas como combo';
    Object.assign(btnCriar.style, estiloBotao('#546e7a', '#fff', { marginBottom: '10px', fontSize: '12px' }));
    btnCriar.onclick = function () {
      var selecionadas = recolherSelecionadas();
      if (!selecionadas.length) {
        showToast('Seleciona tarefas na aba "Tarefas" primeiro', true);
        return;
      }
      var nome = window.prompt('Nome do combo:', '');
      if (!nome || !nome.trim()) return;
      var combos = obterCombos();
      combos.push({ id: Date.now(), nome: nome.trim(), itens: selecionadas });
      guardarCombos(combos);
      renderizarAbaCombos(container);
      showToast('✓ Combo "' + nome.trim() + '" guardado', false);
    };
    container.appendChild(btnCriar);

    var combos = obterCombos();
    if (!combos.length) {
      var vazio = document.createElement('div');
      vazio.innerText = 'Ainda não tens combos guardados.';
      Object.assign(vazio.style, { fontSize: '12.5px', color: '#999', textAlign: 'center', padding: '14px 0' });
      container.appendChild(vazio);
      return;
    }

    var listaWrapCombos = document.createElement('div');
    Object.assign(listaWrapCombos.style, { maxHeight: '280px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' });

    combos.forEach(function (combo) {
      var row = document.createElement('div');
      Object.assign(row.style, {
        display: 'flex', alignItems: 'center', gap: '8px', padding: '8px', borderRadius: '4px',
        border: '1px solid #e0e0e0', backgroundColor: '#fafafa'
      });

      var info = document.createElement('div');
      info.style.flex = '1';
      var nomeEl = document.createElement('div');
      nomeEl.innerText = combo.nome;
      Object.assign(nomeEl.style, { fontWeight: 'bold', color: '#0078d7', fontSize: '13px' });
      var resumo = document.createElement('div');
      resumo.innerText = combo.itens.map(function (i) { return i.cod + '×' + i.qty; }).join(', ');
      Object.assign(resumo.style, { fontSize: '11px', color: '#777', marginTop: '2px' });
      info.appendChild(nomeEl);
      info.appendChild(resumo);

      var btnUsar = document.createElement('button');
      btnUsar.innerText = '▶';
      btnUsar.title = 'Usar combo';
      Object.assign(btnUsar.style, estiloBotao('#0078d7', '#fff', { padding: '6px 10px' }));
      btnUsar.onclick = function () {
        var exMenu = document.getElementById('nm-menu');
        if (exMenu) exMenu.remove();
        executarSequencia(combo.itens);
      };

      var btnEditar = document.createElement('button');
      btnEditar.innerText = '✏️';
      btnEditar.title = 'Editar combo';
      Object.assign(btnEditar.style, estiloBotao('#f5f5f5', '#546e7a', { padding: '6px 8px' }));
      btnEditar.onclick = function () {
        mostrarEdicaoCombo(combo, container);
      };

      var btnApagar = document.createElement('button');
      btnApagar.innerText = '🗑';
      btnApagar.title = 'Apagar combo';
      Object.assign(btnApagar.style, estiloBotao('#f5f5f5', '#c62828', { padding: '6px 8px' }));
      btnApagar.onclick = function () {
        if (!window.confirm('Apagar o combo "' + combo.nome + '"?')) return; // ✅ confirma antes de apagar
        var atualizados = obterCombos().filter(function (c) { return c.id !== combo.id; });
        guardarCombos(atualizados);
        renderizarAbaCombos(container);
      };

      row.appendChild(info);
      row.appendChild(btnUsar);
      row.appendChild(btnEditar);
      row.appendChild(btnApagar);
      listaWrapCombos.appendChild(row);
    });

    container.appendChild(listaWrapCombos);
  }

  // ✅ Painel de edição de combo — renomear, ajustar quantidades ou remover itens
  function mostrarEdicaoCombo(combo, containerCombos) {
    var exEdit = document.getElementById('nm-edit-combo');
    if (exEdit) exEdit.remove();

    var box = document.createElement('div');
    box.id = 'nm-edit-combo';
    var fab = document.getElementById('nm-fab');
    var rect = fab.getBoundingClientRect();
    Object.assign(box.style, {
      position: 'fixed', top: rect.top + 'px', left: (rect.right + 10) + 'px', zIndex: '10002',
      backgroundColor: '#fff', border: '2px solid #0078d7', padding: '12px', borderRadius: '8px',
      boxShadow: '0 4px 15px rgba(0,0,0,0.3)', minWidth: '280px', maxWidth: '380px',
      fontFamily: 'Segoe UI,Arial,sans-serif'
    });

    var tit = document.createElement('div');
    tit.innerText = '✏️ Editar combo';
    Object.assign(tit.style, { fontWeight: 'bold', color: '#0078d7', marginBottom: '8px', fontSize: '13px' });
    box.appendChild(tit);

    var inpNome = document.createElement('input');
    inpNome.type = 'text';
    inpNome.value = combo.nome;
    Object.assign(inpNome.style, estiloInputTexto({ width: '100%', marginBottom: '8px' }));
    box.appendChild(inpNome);

    // Cópia editável dos itens — só grava no combo original se clicar em "Guardar"
    var itensEditaveis = combo.itens.map(function (i) { return { cod: i.cod, qty: i.qty }; });

    var itensWrap = document.createElement('div');
    Object.assign(itensWrap.style, { maxHeight: '200px', overflowY: 'auto', marginBottom: '10px', display: 'flex', flexDirection: 'column', gap: '4px' });

    function renderItens() {
      itensWrap.innerHTML = '';
      if (!itensEditaveis.length) {
        var vazio = document.createElement('div');
        vazio.innerText = 'Sem itens — apaga o combo se já não precisas dele.';
        Object.assign(vazio.style, { fontSize: '12px', color: '#999', textAlign: 'center', padding: '8px 0' });
        itensWrap.appendChild(vazio);
        return;
      }
      itensEditaveis.forEach(function (item, idx) {
        var row = document.createElement('div');
        Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px' });

        var codLbl = document.createElement('span');
        codLbl.innerText = item.cod;
        Object.assign(codLbl.style, { flex: '1', fontSize: '12.5px', color: '#333' });

        var qtdInp = document.createElement('input');
        qtdInp.type = 'number';
        qtdInp.min = '1';
        qtdInp.value = item.qty;
        Object.assign(qtdInp.style, estiloInputTexto({ width: '48px', padding: '3px 4px', fontSize: '12px', textAlign: 'center' }));
        qtdInp.onchange = function () { itensEditaveis[idx].qty = parseInt(qtdInp.value, 10) || 1; };

        var btnRemover = document.createElement('button');
        btnRemover.innerText = '✕';
        Object.assign(btnRemover.style, estiloBotao('#f5f5f5', '#c62828', { padding: '3px 8px', fontSize: '11px' }));
        btnRemover.onclick = function () {
          itensEditaveis.splice(idx, 1);
          renderItens();
        };

        row.appendChild(codLbl);
        row.appendChild(qtdInp);
        row.appendChild(btnRemover);
        itensWrap.appendChild(row);
      });
    }
    renderItens();
    box.appendChild(itensWrap);

    var rowBtns = document.createElement('div');
    Object.assign(rowBtns.style, { display: 'flex', gap: '6px' });
    var btnGuardar = document.createElement('button');
    btnGuardar.innerText = '💾 Guardar';
    Object.assign(btnGuardar.style, estiloBotao('#0078d7', '#fff', { flex: '1' }));
    btnGuardar.onclick = function () {
      var nomeFinal = inpNome.value.trim();
      if (!nomeFinal) { showToast('O combo precisa de um nome', true); return; }
      if (!itensEditaveis.length) { showToast('O combo precisa de pelo menos uma tarefa', true); return; }
      var combos = obterCombos();
      var idxCombo = -1;
      for (var i = 0; i < combos.length; i++) { if (combos[i].id === combo.id) { idxCombo = i; break; } }
      if (idxCombo !== -1) {
        combos[idxCombo].nome = nomeFinal;
        combos[idxCombo].itens = itensEditaveis;
        guardarCombos(combos);
      }
      box.remove();
      renderizarAbaCombos(containerCombos);
      showToast('✓ Combo atualizado', false);
    };
    var btnCancelar = document.createElement('button');
    btnCancelar.innerText = 'Cancelar';
    Object.assign(btnCancelar.style, estiloBotao('#e0e0e0', '#555', { flex: '1' }));
    btnCancelar.onclick = function () { box.remove(); };
    rowBtns.appendChild(btnGuardar);
    rowBtns.appendChild(btnCancelar);
    box.appendChild(rowBtns);

    document.body.appendChild(box);
  }

  // ✅ Ecrã de confirmação — usado apenas por "Repetir última sequência",
  // para poderes ver o que vai ser feito e cancelar antes de correr
  function mostrarConfirmacaoExecucao(lista) {
    var exConf = document.getElementById('nm-confirm');
    if (exConf) exConf.remove();

    var box = document.createElement('div');
    box.id = 'nm-confirm';
    var fab = document.getElementById('nm-fab');
    var rect = fab.getBoundingClientRect();
    Object.assign(box.style, {
      position: 'fixed', top: rect.top + 'px', left: (rect.right + 10) + 'px', zIndex: '10002',
      backgroundColor: '#fff', border: '2px solid #0078d7', padding: '12px', borderRadius: '8px',
      boxShadow: '0 4px 15px rgba(0,0,0,0.3)', minWidth: '260px', maxWidth: '380px',
      fontFamily: 'Segoe UI,Arial,sans-serif'
    });

    var tit = document.createElement('div');
    tit.innerText = 'Repetir ' + lista.length + ' tarefa' + (lista.length > 1 ? 's' : '') + ':';
    Object.assign(tit.style, { fontWeight: 'bold', color: '#0078d7', marginBottom: '8px', fontSize: '13px' });
    box.appendChild(tit);

    var listaEl = document.createElement('div');
    Object.assign(listaEl.style, { maxHeight: '160px', overflowY: 'auto', marginBottom: '10px', fontSize: '12.5px', color: '#444' });
    lista.forEach(function (item) {
      var l = document.createElement('div');
      l.innerText = item.cod + ' × ' + item.qty;
      l.style.padding = '2px 0';
      listaEl.appendChild(l);
    });
    box.appendChild(listaEl);

    var rowBtns = document.createElement('div');
    Object.assign(rowBtns.style, { display: 'flex', gap: '6px' });
    var btnConf = document.createElement('button');
    btnConf.innerText = '✓ Confirmar';
    Object.assign(btnConf.style, estiloBotao('#0078d7', '#fff', { flex: '1' }));
    btnConf.onclick = function () { box.remove(); executarSequencia(lista); };
    var btnCanc = document.createElement('button');
    btnCanc.innerText = 'Cancelar';
    Object.assign(btnCanc.style, estiloBotao('#e0e0e0', '#555', { flex: '1' }));
    btnCanc.onclick = function () { box.remove(); };
    rowBtns.appendChild(btnConf);
    rowBtns.appendChild(btnCanc);
    box.appendChild(rowBtns);

    document.body.appendChild(box);
  }

  // Cria uma linha de tarefa com checkbox + campo de quantidade (oculto até selecionar)
  function criarLinhaMultiSelect(t) {
    var row = document.createElement('div');
    Object.assign(row.style, {
      display: 'flex', alignItems: 'center', gap: '8px',
      padding: '6px 8px', borderRadius: '4px',
      border: '1px solid #e0e0e0', backgroundColor: '#fafafa',
      cursor: 'pointer', transition: 'background 0.15s'
    });

    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.dataset.cod = t.cod;
    Object.assign(cb.style, { cursor: 'pointer', flexShrink: '0', width: '15px', height: '15px' });

    var label = document.createElement('span');
    label.innerHTML = '<span style="font-weight:bold;color:#0078d7">' + t.cod + '</span>' +
      (t.desc ? ' <span style="color:#555;font-size:12px">— ' + t.desc + '</span>' : '');
    Object.assign(label.style, { flex: '1', fontSize: '12.5px', lineHeight: '1.4', cursor: 'pointer' });

    // Campo quantidade — só aparece quando selecionado
    var qtdWrap = document.createElement('div');
    Object.assign(qtdWrap.style, { display: 'none', alignItems: 'center', gap: '3px', flexShrink: '0' });
    var qtdLabel = document.createElement('span');
    qtdLabel.innerText = 'Qtd:';
    Object.assign(qtdLabel.style, { fontSize: '11px', color: '#777' });
    var qtdInp = document.createElement('input');
    qtdInp.type = 'number';
    qtdInp.value = '1';
    qtdInp.min = '1';
    qtdInp.dataset.qtd = 'true';
    Object.assign(qtdInp.style, estiloInputTexto({ width: '48px', padding: '3px 4px', fontSize: '12px', textAlign: 'center' }));
    qtdInp.onclick = function (e) { e.stopPropagation(); };
    qtdWrap.appendChild(qtdLabel);
    qtdWrap.appendChild(qtdInp);

    function toggleSelecao(selecionado) {
      cb.checked = selecionado;
      if (selecionado) {
        Object.assign(row.style, { backgroundColor: '#e8f4ff', border: '1px solid #0078d7' });
        qtdWrap.style.display = 'flex';
        qtdInp.focus();
        qtdInp.select();
      } else {
        Object.assign(row.style, { backgroundColor: '#fafafa', border: '1px solid #e0e0e0' });
        qtdWrap.style.display = 'none';
        qtdInp.value = '1';
      }
      var menu = document.getElementById('nm-menu');
      if (menu && menu._atualizarBtnExecutar) menu._atualizarBtnExecutar();
    }

    row.onclick = function () { toggleSelecao(!cb.checked); };
    cb.onclick = function (e) { e.stopPropagation(); toggleSelecao(cb.checked); };
    row._selecionar = toggleSelecao; // exposto para reaplicar seleção após refresh da lista

    row.appendChild(cb);
    row.appendChild(label);
    row.appendChild(qtdWrap);
    return row;
  }

  // Recolhe as tarefas selecionadas com as suas quantidades
  function recolherSelecionadas() {
    var menu = document.getElementById('nm-menu');
    if (!menu) return [];
    var resultado = [];
    menu.querySelectorAll('input[type="checkbox"][data-cod]').forEach(function (cb) {
      if (cb.checked) {
        var wrap = cb.closest('div');
        var qtdInp = wrap ? wrap.querySelector('input[data-qtd]') : null;
        var qty = qtdInp ? (parseInt(qtdInp.value, 10) || 1) : 1;
        resultado.push({ cod: cb.dataset.cod, qty: qty });
      }
    });
    return resultado;
  }

  // ── Execução sequencial ───────────────────────────────────────────────────
  function executarSequencia(lista) {
    if (!lista.length) return;
    var index = 0;

    GM_setValue('ultimaSequencia', JSON.stringify(lista)); // ✅ para o botão "Repetir última sequência"
    fabRunning(); // ✅ borda amarela intermitente enquanto processa

    function proxima() {
      if (index >= lista.length) {
        fabSuccess(); // ✅ borda verde fixa alguns segundos, sem toast
        return;
      }
      var item = lista[index++];
      executarUma(item.cod, item.qty, function () {
        setTimeout(proxima, T_ENTRE_TAREFAS);
      });
    }
    proxima();
  }

  function formularioJaAberto() {
    var f = document.getElementById(ID_INPUT_TAREFA);
    return f && f.offsetParent !== null;
  }

  function executarUma(cod, qty, callback) {
    if (!formularioJaAberto()) {
      var img = document.querySelector('img[src*="recolha_tarefas_seleccao_branco.png"]');
      if (img) img.click();
      // ✅ OTIMIZAÇÃO: em vez de esperar sempre 800ms fixos, avança assim
      // que o formulário estiver visível (normalmente é bem mais rápido)
      waitFor(formularioJaAberto, function () {
        preencherEAdicionar(cod, qty, callback);
      }, T_ESPERA_ABRIR_FORM);
    } else {
      preencherEAdicionar(cod, qty, callback);
    }
  }

  function setNativeValue(el, value) {
    // Compatibilidade com frameworks que interceptam o setter
    var nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (nativeSetter && nativeSetter.set) {
      nativeSetter.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function aguardarTarefaGravada(callback) {
    var inputTarefa = document.getElementById(ID_INPUT_TAREFA);
    if (!inputTarefa) { callback(); return; }
    waitFor(function () {
      return inputTarefa.value.trim() === '';
    }, function () {
      callback();
    }, T_POLL_CONFIRMACAO);
  }

  function preencherEAdicionar(cod, qty, callback) {
    var inputTarefa = document.getElementById(ID_INPUT_TAREFA);
    if (!inputTarefa) {
      showToast('Erro: campo Tarefa não encontrado', true);
      fabIdle();
      if (callback) callback();
      return;
    }

    inputTarefa.focus();
    setNativeValue(inputTarefa, cod);

    setTimeout(function () {
      var brigada = GM_getValue('brigada', '');
      var numMecano = GM_getValue('numMecano', '');

      var b = document.getElementById(ID_BRIGADA);
      if (b && brigada) setNativeValue(b, brigada);

      var m = document.getElementById(ID_NUM_MECANO);
      if (m && numMecano) setNativeValue(m, numMecano);

      var usarDataHoje = GM_getValue('usarDataHoje', true);
      var dataParaUsar = usarDataHoje
        ? new Date().toISOString().split('T')[0]
        : GM_getValue('dataEscolhida', new Date().toISOString().split('T')[0]);

      var d = document.getElementById(ID_DATA);
      if (d) setNativeValue(d, dataParaUsar);

      // Preencher quantidade
      var qtdField = document.getElementById(ID_QUANTIDADE);
      if (qtdField) {
        setNativeValue(qtdField, String(qty));
      }

      // Clicar no botão "+" para adicionar a tarefa
      setTimeout(function () {
        var btnAdicionar = document.getElementById(ID_BTN_ADICIONAR);
        if (btnAdicionar) {
          btnAdicionar.click();
        } else {
          // Fallback: botão antigo
          var imgF = document.querySelector('img[src*="recolha_tarefas_seleccao_branco.png"]');
          if (imgF) imgF.click();
        }
        aguardarTarefaGravada(function () {
          if (callback) callback();
        });
      }, T_ESPERA_ANTES_CLICAR);
    }, T_ESPERA_APOS_CODIGO);
  }

  // ── FAB ───────────────────────────────────────────────────────────────────
  function criarFAB() {
    injetarEstilos();

    var fab = document.createElement('div');
    fab.id = 'nm-fab';
    fabEl = fab;

    var savedLeft = GM_getValue('fabLeft', null);
    var savedTop = GM_getValue('fabTop', null);

    Object.assign(fab.style, {
      position: 'fixed',
      left: savedLeft !== null ? savedLeft + 'px' : 'auto',
      top: savedTop !== null ? savedTop + 'px' : 'auto',
      right: savedLeft !== null ? 'auto' : '20px',
      bottom: savedTop !== null ? 'auto' : '50%',
      zIndex: '10001',
      width: '42px', height: '42px',
      backgroundColor: '#0078d7', color: '#fff',
      borderRadius: '50%', boxShadow: '0 3px 10px rgba(0,0,0,0.35)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      cursor: 'grab', fontSize: '15px', fontWeight: 'bold',
      fontFamily: 'Segoe UI,Arial,sans-serif',
      userSelect: 'none', transition: 'box-shadow 0.2s'
    });
    fab.innerText = 'T';
    fab.title = 'Nemesis Tarefas (arrasta para mover)';

    var isDragging = false, hasDragged = false;
    var startMouseX, startMouseY, startLeft, startTop;

    fab.addEventListener('mousedown', function (e) {
      e.preventDefault();
      isDragging = true;
      hasDragged = false;
      var rect = fab.getBoundingClientRect();
      startMouseX = e.clientX;
      startMouseY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      fab.style.right = 'auto';
      fab.style.bottom = 'auto';
      fab.style.left = startLeft + 'px';
      fab.style.top = startTop + 'px';
      fab.style.cursor = 'grabbing';
      fab.style.opacity = '0.85';
    });

    document.addEventListener('mousemove', function (e) {
      if (!isDragging) return;
      var dx = e.clientX - startMouseX;
      var dy = e.clientY - startMouseY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) hasDragged = true;
      var newLeft = Math.max(0, Math.min(window.innerWidth - 42, startLeft + dx));
      var newTop = Math.max(0, Math.min(window.innerHeight - 42, startTop + dy));
      fab.style.left = newLeft + 'px';
      fab.style.top = newTop + 'px';
    });

    document.addEventListener('mouseup', function () {
      if (!isDragging) return;
      isDragging = false;
      fab.style.cursor = 'grab';
      fab.style.opacity = '1';
      if (hasDragged) {
        GM_setValue('fabLeft', parseFloat(fab.style.left));
        GM_setValue('fabTop', parseFloat(fab.style.top));
        ['nm-menu', 'nm-settings'].forEach(function (id) {
          var el = document.getElementById(id);
          if (el) el.remove();
        });
      } else {
        // ✅ OTIMIZAÇÃO: mostra logo a lista em cache (se existir) sem esperar
        // pela rede, e atualiza em segundo plano assim que a resposta chegar
        var cacheBruta = GM_getValue(CACHE_KEY, null);
        var tinhaCache = false;
        if (cacheBruta) {
          try {
            var tarefasCache = JSON.parse(cacheBruta);
            if (tarefasCache && tarefasCache.length) {
              tarefas = tarefasCache;
              tinhaCache = true;
              abrirMenu(null);
            }
          } catch (e) { /* cache inválida, ignora */ }
        }

        carregarTarefas(function (t, erro) {
          var listaMudou = JSON.stringify(t) !== JSON.stringify(tarefas);
          if (!tinhaCache) {
            // não havia cache: este é o primeiro carregamento, abre agora
            tarefas = erro ? [] : t;
            abrirMenu(erro);
            return;
          }
          // já havia cache e o menu já está aberto: só refresca se mudou algo
          if (!erro && listaMudou) {
            tarefas = t;
            atualizarListaMenu(null);
          }
          // se der erro mas já tínhamos cache válida, mantém a cache visível e ignora o erro
        });
      }
    });

    document.body.appendChild(fab);
  }

  criarFAB();
})();
