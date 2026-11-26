(function () {
    const DEFAULT_GIST_ID = '1bbbcdd6fdfd4660e6e6ca26a6eab610';
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
        gistTagEl.textContent = `Mã cổng quán: …${gistId.slice(-6)} • v5`;
    }

    if (switchLink && gistId) {
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
    let lastCheckedAtMs = 0;

    function defaultOpenLabel() {
        return isBar ? '🚀 Vào màn hình Pha Chế (Bar) ngay' : '🚀 Vào màn hình Order ngay';
    }

    function setState(kind, headline, detail, showOpenBtn, showRetryBtn, customOpenLabel) {
        if (statusEl) {
            statusEl.textContent = headline;
            statusEl.className = 'portal-status ' + kind;
        }
        if (detailEl) detailEl.textContent = detail || '';
        if (spinnerEl) spinnerEl.style.display = kind === 'loading' ? 'inline-block' : 'none';
        if (openBtn) {
            openBtn.style.display = showOpenBtn && currentDestUrl ? 'inline-flex' : 'none';
            openBtn.textContent = customOpenLabel || defaultOpenLabel();
            if (currentDestUrl) openBtn.href = currentDestUrl;
        }
        if (retryBtn) {
            const wantRetry = typeof showRetryBtn === 'boolean' ? showRetryBtn : !showOpenBtn;
            retryBtn.style.display = wantRetry ? 'inline-flex' : 'none';
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

    async function probeServerOnce(baseUrl, timeoutMs) {
        try {
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), timeoutMs || 5500);
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

    async function probeServerOnline(baseUrl) {
        if (await probeServerOnce(baseUrl, 5500)) return true;
        // DNS / TLS tên miền trycloudflare mới trên mạng 4G đôi khi cần thêm 1.5s để ấm
        await new Promise((r) => setTimeout(r, 1500));
        return await probeServerOnce(baseUrl, 5500);
    }

    async function runCheck(manual) {
        if (checking) return;
        checking = true;
        lastCheckedAtMs = Date.now();
        if (retryBtn) retryBtn.disabled = true;

        setState('loading',
            manual ? '🔄 Đang kiểm tra lại máy chủ...' : '🔄 Đang tìm máy chủ Bass & Brew mới nhất...',
            'Đang tự động kết nối tới laptop tại quầy (0đ, không cần quét lại mã QR).',
            false,
            false);

        try {
            const data = await fetchLivePointer();
            if (!data) {
                setState('warn',
                    '⚠️ Chưa tải được địa chỉ máy chủ',
                    'Hãy kiểm tra mạng 4G/Wi-Fi trên điện thoại rồi bấm nút bên dưới để thử lại.',
                    false,
                    true);
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
                    false,
                    true);
                return;
            }

            if (!/^https:\/\/[a-z0-9.-]+$/i.test(liveUrl)) {
                currentDestUrl = '';
                setState('warn', '⚠️ Địa chỉ máy chủ chưa sẵn sàng', 'Chờ laptop đồng bộ xong rồi bấm "Thử kết nối lại ngay".', false, true);
                return;
            }

            currentDestUrl = `${liveUrl}${targetPath}`;
            setState('loading', `⚡ Đang nối tới máy chủ ${shop}...`, 'Đang xác nhận máy chủ đang hoạt động để tránh lỗi 502...', false, false);
            const alive = await probeServerOnline(liveUrl);

            if (alive) {
                if (isStandalone || forceAuto) {
                    setState('ok',
                        `✅ Đã kết nối ${shop}! Đang vào ngay...`,
                        'Nếu màn hình chưa tự chuyển sau 2 giây, bấm nút bên dưới.',
                        true,
                        true);
                    // Dùng location.href (thay vì replace) để giữ lịch sử Cổng Cố Định khi quay lại trên iOS
                    window.location.href = currentDestUrl;
                    return;
                }
                // Đang mở trên trình duyệt Safari lần đầu (quét QR): giữ trang ở link cố định để ghim chuẩn "Thêm vào MH chính"!
                setState('ok',
                    `🟢 Máy chủ ${shop} đang sẵn sàng!`,
                    'Hãy ghim trang này ra Màn hình chính NGAY BÂY GIỜ (làm 1 lần duy nhất), hoặc bấm nút bên dưới để vào bán hàng ngay.',
                    true,
                    false);
                return;
            }

            // Gist đang báo online nhưng ping kiểm tra chậm/bị chặn CORS -> vẫn hiện sẵn nút mở trực tiếp dự phòng!
            setState('closed',
                `⏳ Máy chủ ${shop} chưa phản hồi kịp`,
                (updatedAt ? `Link mới nhất lúc ${updatedAt}. ` : '') +
                'Nếu laptop đã báo xanh 3G/4G, bạn bấm "Thử kết nối lại" hoặc "Mở trực tiếp máy chủ" bên dưới.',
                true,
                true,
                '⚡ Mở trực tiếp máy chủ');
        } finally {
            checking = false;
            if (retryBtn) retryBtn.disabled = false;
        }
    }

    if (retryBtn) {
        retryBtn.addEventListener('click', () => runCheck(true));
    }

    if (openBtn) {
        openBtn.textContent = defaultOpenLabel();
    }

    function checkOnReturnFromBackground() {
        if (!isStandalone || checking) return;
        const now = Date.now();
        if ((hiddenAtMs > 0 && (now - hiddenAtMs) >= 2000) || (now - lastCheckedAtMs) >= 6000) {
            hiddenAtMs = 0;
            runCheck(false);
        }
    }

    // Khi thoát app ra nền hoặc đóng cửa sổ SFSafariViewController trên iPhone rồi mở lại -> kiểm tra lại đúng 1 nhịp (0 auto-poll!)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            hiddenAtMs = Date.now();
        } else if (document.visibilityState === 'visible') {
            checkOnReturnFromBackground();
        }
    });
    window.addEventListener('focus', checkOnReturnFromBackground);
    window.addEventListener('pageshow', (e) => {
        if (e.persisted && isStandalone) {
            runCheck(false);
        }
    });

    // Kiểm tra 1 lần duy nhất khi mở trang — sau đó hoàn toàn bấm tay để không tốn lượt API!
    runCheck(false);
})();
