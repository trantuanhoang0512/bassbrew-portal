(function () {
    const DEFAULT_GIST_ID = '29d521d92fa1314ea0f8fe8e1a421d1f';
    const STORAGE_KEY_GIST = 'bb_portal_gist_id';

    const params = new URLSearchParams(window.location.search);
    const paramGist = (params.get('g') || '').trim();
    const targetPath = (document.body.getAttribute('data-target') || '/order').trim();

    let gistId = DEFAULT_GIST_ID;
    if (/^[a-f0-9]{20,64}$/i.test(paramGist)) {
        gistId = paramGist;
        try { localStorage.setItem(STORAGE_KEY_GIST, gistId); } catch {}
    } else {
        try {
            const saved = (localStorage.getItem(STORAGE_KEY_GIST) || '').trim();
            if (/^[a-f0-9]{20,64}$/i.test(saved)) gistId = saved;
        } catch {}
    }

    const statusEl = document.getElementById('portal-status');
    const detailEl = document.getElementById('portal-detail');
    const retryBtn = document.getElementById('portal-retry-btn');
    const spinnerEl = document.getElementById('portal-spinner');
    const switchLink = document.getElementById('portal-switch-link');

    if (switchLink && gistId !== DEFAULT_GIST_ID) {
        const baseHref = switchLink.getAttribute('href') || '';
        if (baseHref && !baseHref.includes('?')) {
            switchLink.setAttribute('href', `${baseHref}?g=${encodeURIComponent(gistId)}`);
        }
    }

    let retryTimer = null;
    let checking = false;

    function setState(kind, headline, detail) {
        if (statusEl) {
            statusEl.textContent = headline;
            statusEl.className = 'portal-status ' + kind;
        }
        if (detailEl) detailEl.textContent = detail || '';
        if (spinnerEl) spinnerEl.style.display = kind === 'loading' ? 'inline-block' : 'none';
    }

    async function fetchLivePointer() {
        const ts = Date.now();
        // 1. Ưu tiên GitHub Gist API (0ms cache CDN, cập nhật tức thì < 500ms)
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 6000);
            const resp = await fetch(`https://api.github.com/gists/${encodeURIComponent(gistId)}?t=${ts}`, {
                cache: 'no-store',
                headers: { 'Accept': 'application/vnd.github+json' },
                signal: ctrl.signal
            });
            clearTimeout(t);
            if (resp.ok) {
                const gist = await resp.json();
                const files = gist && gist.files ? gist.files : {};
                const fileObj = files['bassbrew_live.json'] || Object.values(files)[0];
                if (fileObj && fileObj.content) {
                    return JSON.parse(fileObj.content);
                }
            }
        } catch {}

        // 2. Dự phòng raw Gist nếu chạm giới hạn API IP công cộng
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 6000);
            const resp = await fetch(`https://gist.githubusercontent.com/raw/${encodeURIComponent(gistId)}/bassbrew_live.json?t=${ts}`, {
                cache: 'no-store',
                signal: ctrl.signal
            });
            clearTimeout(t);
            if (resp.ok) {
                return await resp.json();
            }
        } catch {}

        return null;
    }

    async function probeServerOnline(baseUrl) {
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 4500);
            const resp = await fetch(`${baseUrl}/api/ping?p=${Date.now()}`, {
                cache: 'no-store',
                mode: 'cors',
                signal: ctrl.signal
            });
            clearTimeout(t);
            return resp.ok;
        } catch {
            return false;
        }
    }

    function scheduleRetry() {
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => runCheck(false), 4000);
    }

    async function runCheck(manual) {
        if (checking) return;
        checking = true;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        if (retryBtn) retryBtn.disabled = true;

        setState('loading',
            manual ? '🔄 Đang kiểm tra lại máy chủ...' : '🔄 Đang tìm máy chủ Bass & Brew mới nhất...',
            'Đang tự động kết nối tới laptop tại quầy (0đ, không cần quét lại mã QR).');

        try {
            const data = await fetchLivePointer();
            if (!data) {
                setState('warn',
                    '⚠️ Chưa tải được địa chỉ máy chủ',
                    'Hãy kiểm tra mạng 4G/Wi-Fi trên điện thoại. Trang sẽ tự thử lại sau 4 giây...');
                scheduleRetry();
                return;
            }

            const shop = (data.shop || 'Bass & Brew').trim();
            const liveUrl = (data.url || '').trim().replace(/\/+$/, '');
            const st = (data.status || '').toLowerCase();
            const updatedAt = (data.updatedAt || '').trim();

            if (st === 'closed' || !liveUrl) {
                setState('closed',
                    `🔌 Máy chủ ${shop} hiện đang đóng phiên`,
                    (updatedAt ? `Cập nhật lúc ${updatedAt}. ` : '') +
                    'Ngay khi thu ngân mở app trên laptop, màn hình này sẽ tự động vào ngay!');
                scheduleRetry();
                return;
            }

            if (!/^https:\/\/[a-z0-9.-]+$/i.test(liveUrl)) {
                setState('warn', '⚠️ Địa chỉ máy chủ chưa sẵn sàng', 'Đang chờ laptop đồng bộ đường truyền mới...');
                scheduleRetry();
                return;
            }

            setState('loading', `⚡ Đang nối tới máy chủ ${shop}...`, 'Đang xác nhận máy chủ đang hoạt động để tránh lỗi 502...');
            const alive = await probeServerOnline(liveUrl);

            if (alive) {
                setState('ok', `✅ Đã kết nối ${shop}! Đang mở...`, '');
                const dest = `${liveUrl}${targetPath}`;
                window.location.replace(dest);
                return;
            }

            setState('closed',
                `⏳ Máy chủ ${shop} đang khởi động hoặc tạm tắt`,
                (updatedAt ? `Lần mở gần nhất: ${updatedAt}. ` : '') +
                'Hãy đảm bảo app Bass & Brew trên laptop đang mở — điện thoại sẽ tự vào ngay sau 4 giây khi sẵn sàng!');
            scheduleRetry();
        } finally {
            checking = false;
            if (retryBtn) retryBtn.disabled = false;
        }
    }

    if (retryBtn) {
        retryBtn.addEventListener('click', () => runCheck(true));
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            runCheck(false);
        }
    });

    runCheck(false);
})();
