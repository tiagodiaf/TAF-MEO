// ==UserScript==
// @name         Nemesis Tarefas
// @namespace    https://github.com/tiagodiaf/TAF-MEO/
// @version      1.6
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

  const VERSAO_SCRIPT = "1.6";
  const GIST_URL = "https://gist.githubusercontent.com/tiagodiaf/611272ebb7015a7d3c7a6f12c2c1d0a6/raw/nemesis-tarefas.json?v=" + Date.now();
  const ID_NUM_MECANO       = 'wtWBAddTarefas_wtRecolha_Nmec';
  const ID_INPUT_TAREFA     = 'wtWBAddTarefas_wtInputTarefa';
  const ID_QUANTIDADE       = 'wtWBAddTarefas_wtRecolha_Qtd';
  const ID_BRIGADA          = 'wtWBAddTarefas_wtRecolha_Brigada';
  const ID_DATA             = 'wtWBAddTarefas_wtRecolha_DataSP';
  // ✅ ALTERAÇÃO 1: ID correto do botão "+"
  const ID_BTN_ADICIONAR    = 'wtWBAddTarefas_wtimg_nova_tarefa';

  let tarefas = [];

  function carregarTarefas(cb) {
    GM_xmlhttpRequest({
      method: 'GET',
      url: GIST_URL,
      onload: function (r) {
        try {
          const data = JSON.parse(r.responseText);
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
      Object.assign(inp.style, {
        width: '100%', padding: '6px 8px', border: '1px solid #ccc',
        borderRadius: '4px', fontSize: '13px', boxSizing: 'border-box'
      });
      wrap.appendChild(lbl);
      wrap.appendChild(inp);
      panel.appendChild(wrap);
    }

    addField('Brigada', 'brigada', 'ex: 27/6785');
    addField('Número Mecânico', 'numMecano', 'ex: 75086');

    var btnGuardar = document.createElement('button');
    btnGuardar.innerText = '💾 Guardar';
    Object.assign(btnGuardar.style, {
      width: '100%', padding: '8px', backgroundColor: '#555', color: '#fff',
      border: 'none', borderRadius: '4px', cursor: 'pointer', fontWeight: 'bold', fontSize: '13px'
    });
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
      top: rect.top + 'px',
      left: (rect.right + 10) + 'px',
      zIndex: '10002', backgroundColor: '#fff', border: '2px solid #0078d7',
      padding: '12px', borderRadius: '8px', boxShadow: '0 4px 15px rgba(0,0,0,0.3)',
      display: 'flex', flexDirection: 'column', gap: '6px',
      minWidth: '400px', maxWidth: '520px',
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

    // Área de scroll para as tarefas
    var listaWrap = document.createElement('div');
    Object.assign(listaWrap.style, {
      maxHeight: '320px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px'
    });

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
        var row = criarLinhaMultiSelect(t);
        listaWrap.appendChild(row);
      });
    }
    menu.appendChild(listaWrap);

    var hr = document.createElement('hr');
    Object.assign(hr.style, { margin: '4px 0', border: 'none', borderTop: '1px solid #ddd' });
    menu.appendChild(hr);

    // Linha manual
    var rowManual = document.createElement('div');
    Object.assign(rowManual.style, { display: 'flex', gap: '6px', alignItems: 'center' });
    var inpCod = document.createElement('input');
    inpCod.type = 'text';
    inpCod.placeholder = 'Código manual (ex: P0999)';
    Object.assign(inpCod.style, {
      flex: '1', padding: '6px 8px', border: '1px solid #b3d4f5',
      borderRadius: '4px', fontSize: '13px'
    });
    var inpQtdManual = document.createElement('input');
    inpQtdManual.type = 'number';
    inpQtdManual.value = '1';
    inpQtdManual.min = '1';
    inpQtdManual.title = 'Quantidade';
    Object.assign(inpQtdManual.style, {
      width: '52px', padding: '6px 4px', border: '1px solid #b3d4f5',
      borderRadius: '4px', fontSize: '13px', textAlign: 'center'
    });
    var btnOk = document.createElement('button');
    btnOk.innerText = '▶';
    Object.assign(btnOk.style, {
      padding: '6px 14px', cursor: 'pointer', backgroundColor: '#546e7a',
      color: '#fff', border: 'none', borderRadius: '4px', fontWeight: 'bold'
    });
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
    menu.appendChild(rowManual);

    // Linha de data — checkbox "usar data de hoje" + input de data (valores reutilizados entre execuções)
    var rowData = document.createElement('div');
    Object.assign(rowData.style, { display: 'flex', gap: '6px', alignItems: 'center', marginTop: '2px' });

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
    menu.appendChild(rowData);

    // Botão "Executar selecionadas"
    var btnExecutar = document.createElement('button');
    btnExecutar.id = 'nm-btn-executar';
    btnExecutar.innerText = 'Executar tarefas selecionadas';
    Object.assign(btnExecutar.style, {
      padding: '8px', cursor: 'pointer', backgroundColor: '#e0e0e0',
      color: '#999', border: 'none', borderRadius: '4px',
      fontWeight: 'bold', fontSize: '13px', marginTop: '2px'
    });
    btnExecutar.disabled = true;
    btnExecutar.onclick = function () {
      var selecionadas = recolherSelecionadas();
      if (!selecionadas.length) return;
      menu.remove();
      executarSequencia(selecionadas);
    };
    menu.appendChild(btnExecutar);

    // Versão
    var vText = document.createElement('div');
    vText.innerText = 'v' + VERSAO_SCRIPT;
    Object.assign(vText.style, { fontSize: '9px', color: '#bbb', textAlign: 'right', marginTop: '2px' });
    menu.appendChild(vText);

    document.body.appendChild(menu);
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
    Object.assign(qtdInp.style, {
      width: '48px', padding: '3px 4px', border: '1px solid #b3d4f5',
      borderRadius: '4px', fontSize: '12px', textAlign: 'center'
    });
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

    function proxima() {
      if (index >= lista.length) {
        showToast('✓ ' + lista.length + ' tarefa(s) adicionada(s)', false);
        return;
      }
      var item = lista[index++];
      executarUma(item.cod, item.qty, function () {
        setTimeout(proxima, 600);
      });
    }
    proxima();
  }

  function formularioJaAberto() {
    var f = document.getElementById('wtWBAddTarefas_wtInputTarefa');
    return f && f.offsetParent !== null;
  }

  function executarUma(cod, qty, callback) {
    if (!formularioJaAberto()) {
      var img = document.querySelector('img[src*="recolha_tarefas_seleccao_branco.png"]');
      if (img) img.click();
      setTimeout(function () { preencherEAdicionar(cod, qty, callback); }, 800);
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

  // ✅ ALTERAÇÃO 2: aguarda o campo ficar vazio antes de chamar o callback
  function aguardarTarefaGravada(callback) {
    var inputTarefa = document.getElementById(ID_INPUT_TAREFA);
    if (!inputTarefa) { callback(); return; }
    var elapsed = 0;
    var poll = setInterval(function () {
      elapsed += 150;
      if (inputTarefa.value.trim() === '') {
        clearInterval(poll);
        callback();
      } else if (elapsed >= 4000) {
        clearInterval(poll);
        callback();
      }
    }, 150);
  }

  function preencherEAdicionar(cod, qty, callback) {
    var inputTarefa = document.getElementById('wtWBAddTarefas_wtInputTarefa');
    if (!inputTarefa) { showToast('Erro: campo Tarefa não encontrado', true); if (callback) callback(); return; }

    inputTarefa.focus();
    setNativeValue(inputTarefa, cod);

    setTimeout(function () {
      var brigada = GM_getValue('brigada', '');
      var numMecano = GM_getValue('numMecano', '');

      var b = document.getElementById('wtWBAddTarefas_wtRecolha_Brigada');
      if (b && brigada) setNativeValue(b, brigada);

      var m = document.getElementById(ID_NUM_MECANO);
      if (m && numMecano) setNativeValue(m, numMecano);

      var usarDataHoje = GM_getValue('usarDataHoje', true);
      var dataParaUsar = usarDataHoje
        ? new Date().toISOString().split('T')[0]
        : GM_getValue('dataEscolhida', new Date().toISOString().split('T')[0]);

      var d = document.getElementById('wtWBAddTarefas_wtRecolha_DataSP');
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
        // ✅ ALTERAÇÃO 3: aguardar confirmação real em vez de chamar callback imediatamente
        aguardarTarefaGravada(function () {
          if (callback) callback();
        });
      }, 400);
    }, 600);
  }

  // ── FAB ───────────────────────────────────────────────────────────────────
  function criarFAB() {
    var fab = document.createElement('div');
    fab.id = 'nm-fab';

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
        carregarTarefas(function (t, erro) {
          tarefas = t;
          abrirMenu(erro);
        });
      }
    });

    document.body.appendChild(fab);
  }

  criarFAB();
})();
