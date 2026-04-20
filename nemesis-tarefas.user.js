// ==UserScript==
// @name         Nemesis Tarefas
// @namespace    https://github.com/tiagodiaf
// @version      1.1
// @description  Preenchimento rápido de tarefas no Nemesis
// @author       tiagodiaf
// @match        https://nemesis.telecom.pt/Nemesis_v5/Recolhas.Recolhas_List.aspx*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @connect      gist.githubusercontent.com
// ==/UserScript==

(function () {
  'use strict';

  const GIST_URL = 'https://gist.githubusercontent.com/tiagodiaf/611272ebb7015a7d3c7a6f12c2c1d0a6/raw/nemesis-tarefas.json';

  const ID_NUM_MECANO = 'wtWBAddTarefas_wtRecolha_Nmec';

  let tarefas = [];

  function carregarTarefas(cb) {
    GM_xmlhttpRequest({
      method: 'GET',
      url: GIST_URL + '?t=' + Date.now(),
      onload: function (r) {
        try { cb(JSON.parse(r.responseText), null); }
        catch (e) { cb([], 'Erro ao ler a lista de tarefas.'); }
      },
      onerror: function () { cb([], 'Sem acesso à lista de tarefas.'); }
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
      minWidth: '360px', maxWidth: '500px',
      fontFamily: 'Segoe UI,Arial,sans-serif'
    });

    // Cabeçalho
    var hdr = document.createElement('div');
    Object.assign(hdr.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' });
    var tit = document.createElement('span');
    tit.innerText = 'Selecionar Tarefa';
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

    // Mensagem de erro OU lista de tarefas
    if (erro) {
      var msgErro = document.createElement('div');
      msgErro.innerText = '⚠ ' + erro;
      Object.assign(msgErro.style, {
        padding: '10px', backgroundColor: '#fff3e0', border: '1px solid #ffb74d',
        borderRadius: '4px', color: '#e65100', fontSize: '13px', textAlign: 'center'
      });
      menu.appendChild(msgErro);
    } else {
      tarefas.forEach(function (t) {
        var btn = document.createElement('button');
        btn.innerHTML = '<span style="font-weight:bold;color:#0078d7">' + t.cod + '</span>' +
          (t.desc ? ' &mdash; <span style="color:#333;font-size:12px">' + t.desc + '</span>' : '');
        Object.assign(btn.style, {
          padding: '7px 10px', cursor: 'pointer', backgroundColor: '#f0f7ff',
          border: '1px solid #b3d4f5', borderRadius: '4px',
          textAlign: 'left', fontSize: '12.5px', lineHeight: '1.5'
        });
        btn.onmouseover = function () {
          this.style.backgroundColor = '#0078d7';
          this.querySelectorAll('span').forEach(function (s) { s.style.color = '#fff'; });
        };
        btn.onmouseout = function () {
          this.style.backgroundColor = '#f0f7ff';
          var ss = this.querySelectorAll('span');
          if (ss[0]) ss[0].style.color = '#0078d7';
          if (ss[1]) ss[1].style.color = '#333';
        };
        btn.onclick = function () { menu.remove(); executar(t.cod); };
        menu.appendChild(btn);
      });
    }

    // Separador + input manual (sempre visível)
    var hr = document.createElement('hr');
    Object.assign(hr.style, { margin: '4px 0', border: 'none', borderTop: '1px solid #ddd' });
    menu.appendChild(hr);

    var row = document.createElement('div');
    Object.assign(row.style, { display: 'flex', gap: '6px', alignItems: 'center' });
    var inp = document.createElement('input');
    inp.type = 'text';
    inp.placeholder = 'Código manual (ex: P0999)';
    Object.assign(inp.style, {
      flex: '1', padding: '6px 8px', border: '1px solid #b3d4f5', borderRadius: '4px', fontSize: '13px'
    });
    inp.onkeydown = function (e) {
      if (e.key === 'Enter' && this.value.trim()) { menu.remove(); executar(this.value.trim()); }
    };
    var btnOk = document.createElement('button');
    btnOk.innerText = '▶';
    Object.assign(btnOk.style, {
      padding: '6px 14px', cursor: 'pointer', backgroundColor: '#0078d7',
      color: '#fff', border: 'none', borderRadius: '4px', fontWeight: 'bold'
    });
    btnOk.onclick = function () { if (inp.value.trim()) { menu.remove(); executar(inp.value.trim()); } };
    row.appendChild(inp);
    row.appendChild(btnOk);
    menu.appendChild(row);

    document.body.appendChild(menu);
    inp.focus();
  }

  function formularioJaAberto() {
    var f = document.getElementById('wtWBAddTarefas_wtInputTarefa');
    return f && f.offsetParent !== null;
  }

  function executar(cod) {
    if (!formularioJaAberto()) {
      var img = document.querySelector('img[src*="recolha_tarefas_seleccao_branco.png"]');
      if (img) img.click();
    }
    setTimeout(function () { preencherFormulario(cod); }, 800);
  }

  function preencherFormulario(valor) {
    var inputTarefa = document.getElementById('wtWBAddTarefas_wtInputTarefa');
    if (!inputTarefa) { showToast('Erro: campo Tarefa não encontrado', true); return; }

    inputTarefa.focus();
    inputTarefa.value = valor;
    inputTarefa.dispatchEvent(new Event('input', { bubbles: true }));
    inputTarefa.dispatchEvent(new Event('change', { bubbles: true }));

    setTimeout(function () {
      var brigada = GM_getValue('brigada', '');
      var numMecano = GM_getValue('numMecano', '');

      var b = document.getElementById('wtWBAddTarefas_wtRecolha_Brigada');
      if (b && brigada) b.value = brigada;

      var m = document.getElementById(ID_NUM_MECANO);
      if (m && numMecano) m.value = numMecano;

      var d = document.getElementById('wtWBAddTarefas_wtRecolha_DataSP');
      if (d) d.value = new Date().toISOString().split('T')[0];

      var imgF = document.querySelector('img[src*="recolha_tarefas_seleccao_branco.png"]');
      if (imgF) imgF.click();

      showToast('✓ Tarefa ' + valor + ' preenchida', false);
    }, 1000);
  }

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
