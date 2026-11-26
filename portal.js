(function () {
    const DEFAULT_GIST_ID = '29d521d92fa1314ea0f8fe8e1a421d1f';
    const STORAGE_KEY_GIST = 'bb_portal_gist_id';

    const params = new URLSearchParams(window.location.search);
    const paramGist = (params.get('g') || '').trim();
    const forceAuto = params.get('auto') === '1';
    const targetPath = (document.body.getAttribute('data-target') || '/order').trim();
    const isBar = targetPath.toLowerCase().includes('bar');

    // Phát hiện đang mở từ icon đã ghim ngoài màn hình chính (PWA standalone)
    const isStandalone =
        window.navigator.standalone === true ||
        (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);

    const isIos = /iPhone|iPad|iPod/i.test(navigator.userAgent || '') ||
        (/Macintosh/i.test(navigator.userAgent || '') && navigator.maxTouchPoints > 1);

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

    // Trên Android/Chrome (KHÔNG phải iOS): tiêm manifest động giữ nguyên 100% ?g=<gistId> trong start_url!
    // Trên iOS: giữ nguyên meta apple-mobile-web-app-capable (KHÔNG gắn <link rel="manifest">) để Safari ghim chính xác nguyên URL kèm ?g=...
    if (!isIos) {
        try {
            const baseDir = window.location.href.split('?')[0].replace(/[^/]+$/, '');
            const manifestObj = {
                name: isBar ? 'Bass & Brew — Pha Chế' : 'Bass & Brew — Order',
                short_name: isBar ? 'Bass & Brew Bar' : 'Bass & Brew',
                start_url: window.location.href,
                scope: baseDir,
                display: 'standalone',
                background_color: '#0A0B0F',
                theme_color: '#0A0B0F',
                icons: [
                    { src: baseDir + (isBar ? 'icons/icon-bar-192.png' : 'icons/icon-order-192.png'), sizes: '192x192', type: 'image/png' },
                    { src: baseDir + (isBar ? 'icons/icon-bar-512.png' : 'icons/icon-order-512.png'), sizes: '512x512', type: 'image/png' }
                ]
            };
            const blob = new Blob([JSON.stringify(manifestObj)], { type: 'application/manifest+json' });
            const link = document.createElement('link');
            link.rel = 'manifest';
            link.href = URL.createObjectURL(blob);
            document.head.appendChild(link);
        } catch {}
    }

    const statusEl = document.getElementById('portal-status');
    const detailEl = document.getElementById('portal-detail');
    const openBtn = document.getElementById('portal-open-btn');
    const retryBtn = document.getElementById('portal-retry-btn');
    const pinGuideEl = document.getElementById('portal-pin-guide');
    const spinnerEl = document.getElementById('portal-spinner');
    const switchLink = document.getElementById('portal-switch-link');
    const gistTagEl = document.getElementById('portal-gist-tag');

    if (gistTagEl && gistId) {
        gistTagEl.textContent = `Mã cổng quán: …${gistId.slice(-6)}`;
    }

    if (switchLink && gistId !== DEFAULT_GIST_ID) {
        const baseHref = switchLink.getAttribute('href') || '';
        if (baseHref && !baseHref.includes('?')) {
            switchLink.setAttribute('href', `${baseHref}?g=${encodeURIComponent(gistId)}`);
        }
    }

    // Ẩn khung hướng dẫn ghim khi đã mở từ icon ngoài màn hình chính
    if (pinGuideEl && isStandalone) {
        pinGuideEl.style.display = 'none';
    }

    let checking = false;
    let currentDestUrl = '';
    let hiddenAtMs = 0;

    function setState(kind, headline, detail, showOpenBtn) {
        if (statusEl) {
            statusEl.textContent = headline;
            statusEl.className = 'portal-status ' + kind;
        }
        if (detailEl) detailEl.textContent = detail || '';
        if (spinnerEl) spinnerEl.style.display = kind === 'loading' ? 'inline-block' : 'none';
        if (openBtn) {
            openBtn.style.display = showOpenBtn && currentDestUrl ? 'inline-flex' : 'none';
            if (currentDestUrl) openBtn.href = currentDestUrl;
        }
        if (retryBtn) {
            retryBtn.style.display = showOpenBtn ? 'none' : 'inline-flex';
        }
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

        // 2. Dự phòng raw Gist CDN nếu chạm giới hạn API IP công cộng
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

    async function runCheck(manual) {
        if (checking) return;
        checking = true;
        if (retryBtn) retryBtn.disabled = true;

        setState('loading',
            manual ? '🔄 Đang kiểm tra lại máy chủ...' : '🔄 Đang tìm máy chủ Bass & Brew mới nhất...',
            'Đang tự động kết nối tới laptop tại quầy (0đ, không cần quét lại mã QR).',
            false);

        try {
            const data = await fetchLivePointer();
            if (!data) {
                setState('warn',
                    '⚠️ Chưa tải được địa chỉ máy chủ',
                    'Hãy kiểm tra mạng 4G/Wi-Fi trên điện thoại rồi bấm nút bên dưới để thử lại.',
                    false);
                return;
            }

            const shop = (data.shop || 'Bass & Brew').trim();
            const liveUrl = (data.url || '').trim().replace(/\/+$/, '');
            const st = (data.status || '').toLowerCase();
            const updatedAt = (data.updatedAt || '').trim();

            if (st === 'closed' || !liveUrl) {
                currentDestUrl = '';
                setState('closed',
                    `🔌 Máy chủ ${shop} hiện đang đóng phiên`,
                    (updatedAt ? `Cập nhật lúc ${updatedAt}. ` : '') +
                    'Khi nào laptop tại quầy đã mở phần mềm và báo xanh 3G/4G, hãy bấm "Thử kết nối lại ngay" bên dưới.',
                    false);
                return;
            }

            if (!/^https:\/\/[a-z0-9.-]+$/i.test(liveUrl)) {
                currentDestUrl = '';
                setState('warn', '⚠️ Địa chỉ máy chủ chưa sẵn sàng', 'Chờ laptop đồng bộ xong rồi bấm "Thử kết nối lại ngay".', false);
                return;
            }

            setState('loading', `⚡ Đang nối tới máy chủ ${shop}...`, 'Đang xác nhận máy chủ đang hoạt động để tránh lỗi 502...', false);
            const alive = await probeServerOnline(liveUrl);

            if (alive) {
                currentDestUrl = `${liveUrl}${targetPath}`;
                if (isStandalone || forceAuto) {
                    setState('ok', `✅ Đã kết nối ${shop}! Đang vào ngay...`, '', false);
                    window.location.replace(currentDestUrl);
                    return;
                }
                // Đang mở trên trình duyệt Safari lần đầu (quét QR): giữ trang ở link cố định để ghim chuẩn "Thêm vào MH chính"!
                setState('ok',
                    `🟢 Máy chủ ${shop} đang sẵn sàng!`,
                    'Hãy ghim trang này ra Màn hình chính NGAY BÂY GIỜ (làm 1 lần duy nhất), hoặc bấm nút bên dưới để vào bán hàng ngay.',
                    true);
                return;
            }

            currentDestUrl = '';
            setState('closed',
                `⏳ Máy chủ ${shop} đang khởi động hoặc tạm tắt`,
                (updatedAt ? `Lần mở gần nhất: ${updatedAt}. ` : '') +
                'Hãy đảm bảo app Bass & Brew trên laptop đang mở rồi bấm "Thử kết nối lại ngay" bên dưới.',
                false);
        } finally {
            checking = false;
            if (retryBtn) retryBtn.disabled = false;
        }
    }

    if (retryBtn) {
        retryBtn.addEventListener('click', () => runCheck(true));
    }

    if (openBtn) {
        openBtn.textContent = isBar ? '🚀 Vào màn hình Pha Chế (Bar) ngay' : '🚀 Vào màn hình Order ngay';
    }

    // Khi thoát app ra nền rồi mở lại icon đã ghim trên iPhone -> kiểm tra lại đúng 1 lần (không auto-poll 4 giây!)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            hiddenAtMs = Date.now();
        } else if (document.visibilityState === 'visible' && isStandalone && hiddenAtMs > 0 && (Date.now() - hiddenAtMs) >= 3000) {
            hiddenAtMs = 0;
            runCheck(false);
        }
    });
    window.addEventListener('pageshow', (e) => {
        if (e.persisted && isStandalone) {
            runCheck(false);
        }
    });

    // Kiểm tra 1 lần duy nhất khi mở trang — sau đó hoàn toàn bấm tay để không tốn lượt API!
    runCheck(false);
})();
