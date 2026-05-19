// ==UserScript==
// @name         Manter Sessão Ativa
// @namespace    https://nemesis.telecom.pt/
// @version      1.4
// @description  Impede que a sessão do Nemesis expire enviando pings periódicos
// @author       Claude
// @match        https://nemesis.telecom.pt/*
// @match        https://meostacesso.fastfiber.pt/*
// @match        https://smartdesk.telecom.pt/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ── Configuração ──────────────────────────────────────────────
    const PING_INTERVAL_MS = 5 * 60 * 1000;  // Ping a cada 5 minutos

    // URLs a fazer ping (inclui a página atual + os outros portais)
    const PING_URLS = [
        location.href,
        'https://meostacesso.fastfiber.pt/',
        'https://smartdesk.telecom.pt/',
    ];
    // ─────────────────────────────────────────────────────────────

    // --- Indicador visual: ponto discreto no canto inferior esquerdo ---
    const dot = document.createElement('div');
    dot.id = '__session_keeper_dot__';
    dot.title = 'Session Keeper ativo';
    Object.assign(dot.style, {
        position:     'fixed',
        bottom:       '8px',
        left:         '8px',
        zIndex:       '999999',
        width:        '8px',
        height:       '8px',
        borderRadius: '50%',
        background:   '#2ecc71',
        boxShadow:    '0 0 4px rgba(46,204,113,.7)',
        transition:   'background .4s',
        cursor:       'default',
    });
    document.body.appendChild(dot);

    function flash(ok) {
        dot.style.background = ok ? '#2ecc71' : '#e74c3c';
        dot.style.boxShadow  = ok ? '0 0 4px rgba(46,204,113,.7)' : '0 0 4px rgba(231,76,60,.7)';
        setTimeout(() => {
            dot.style.background  = '#2ecc71';
            dot.style.boxShadow   = '0 0 4px rgba(46,204,113,.7)';
        }, 3000);
    }

    // --- Ping a todos os URLs ---
    async function pingUrl(url) {
        const ts = new Date().toLocaleTimeString('pt-PT');
        try {
            const resp = await fetch(url, {
                method:      'GET',
                credentials: 'include',
                cache:       'no-store',
                keepalive:   true,
                headers:     { 'X-Requested-With': 'XMLHttpRequest' },
            });
            console.log(`[SessionKeeper] ${ts} — ${url} → ${resp.status}`);
            return resp.ok;
        } catch (err) {
            console.warn(`[SessionKeeper] ${ts} — Erro ao fazer ping a ${url}:`, err);
            return false;
        }
    }

    async function keepAlive() {
        const results = await Promise.all(PING_URLS.map(pingUrl));
        flash(results.every(Boolean));
    }

    // --- Arranque ---
    console.log('[SessionKeeper] Ativo. Ping a cada', PING_INTERVAL_MS / 60000, 'min para:', PING_URLS);
    keepAlive();
    setInterval(keepAlive, PING_INTERVAL_MS);

    // --- Ping imediato ao voltar ao tab ---
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') keepAlive();
    });

})();
