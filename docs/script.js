(function () {
    'use strict';

    const sidebarNav = document.getElementById('sidebarNav');
    const mainContent = document.getElementById('mainContent');
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');
    const searchInput = document.getElementById('searchInput');
    const mobileBtn = document.getElementById('mobileMenuBtn');
    const sidebar = document.getElementById('sidebar');
    const backToTop = document.getElementById('backToTop');
    const railTitle = document.getElementById('railTitle');
    const railMeta = document.getElementById('railMeta');
    const chapterToc = document.getElementById('chapterToc');

    const chapterCache = {};
    const chapterIndex = new Map();
    const visited = new Set();
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let allChapterIds = [];
    let currentId = null;
    let currentHeadings = [];
    let totalChapters = 0;
    let pointerFrame = null;

    init();

    async function init() {
        const manifest = await loadManifest();
        if (!manifest) return;

        buildSidebar(manifest.nav);
        bindGlobalEvents();
        bindPointerTracking();

        const hash = window.location.hash.slice(1);
        const startId = hash && allChapterIds.includes(hash) ? hash : (allChapterIds[0] || 'home');
        await navigateTo(startId);
    }

    async function loadManifest() {
        try {
            const response = await fetch('chapters/manifest.json');
            if (!response.ok) {
                throw new Error(response.statusText);
            }
            return await response.json();
        } catch (error) {
            mainContent.innerHTML = `
                <section class="chapter active fade-in">
                    <div class="chapter-header">
                        <span class="chapter-number">載入失敗</span>
                        <h1>無法載入章節索引</h1>
                        <p class="chapter-desc">讀不到 <code>docs/chapters/manifest.json</code>。若你是以靜態伺服器開啟本站，請確認檔案存在；若直接從本機拖曳開啟，瀏覽器可能阻擋了 <code>fetch</code>。</p>
                    </div>
                    <div class="callout callout-warning">
                        <div class="callout-title">錯誤訊息</div>
                        <p>${escapeHtml(error.message)}</p>
                    </div>
                </section>
            `;
            return null;
        }
    }

    function buildSidebar(groups) {
        let html = '';

        groups.forEach((group) => {
            html += `<div class="nav-group"><div class="nav-group-title">${group.title}</div>`;

            group.items.forEach((item) => {
                allChapterIds.push(item.id);
                chapterIndex.set(item.id, item);
                html += `
                    <a href="#${item.id}" class="nav-item" data-chapter="${item.id}">
                        <span class="nav-icon">${item.icon}</span>
                        <span>${item.label}</span>
                    </a>
                `;
            });

            html += '</div>';
        });

        sidebarNav.innerHTML = html;
        totalChapters = allChapterIds.length;

        sidebarNav.querySelectorAll('.nav-item').forEach((item) => {
            item.addEventListener('click', (event) => {
                event.preventDefault();
                navigateTo(item.dataset.chapter);
            });
        });

        updateProgress();
    }

    async function loadChapter(id) {
        if (chapterCache[id]) return chapterCache[id];

        try {
            const response = await fetch(`chapters/${id}.html`);
            if (!response.ok) {
                throw new Error(`${response.status} ${response.statusText}`);
            }
            const html = await response.text();
            chapterCache[id] = html;
            return html;
        } catch (error) {
            return `
                <div class="chapter-header">
                    <span class="chapter-number">章節載入失敗</span>
                    <h1>${escapeHtml(id)}</h1>
                    <p class="chapter-desc">無法載入 <code>chapters/${escapeHtml(id)}.html</code>。</p>
                </div>
                <div class="callout callout-warning">
                    <div class="callout-title">錯誤訊息</div>
                    <p>${escapeHtml(error.message)}</p>
                </div>
            `;
        }
    }

    async function navigateTo(id) {
        if (!allChapterIds.includes(id)) return;
        if (currentId === id) return;

        let target = document.getElementById(id);
        if (!target) {
            target = document.createElement('section');
            target.id = id;
            target.className = 'chapter';
            mainContent.appendChild(target);
        }

        if (!target.dataset.loaded) {
            const html = await loadChapter(id);
            target.innerHTML = html;
            target.dataset.loaded = '1';
            enhanceChapter(target, id);
        }

        mainContent.querySelectorAll('.chapter').forEach((chapter) => {
            chapter.classList.remove('active', 'fade-in');
        });
        target.classList.add('active');
        requestAnimationFrame(() => {
            target.classList.add('fade-in');
        });

        sidebarNav.querySelectorAll('.nav-item').forEach((item) => {
            item.classList.toggle('active', item.dataset.chapter === id);
            if (item.dataset.chapter === id) {
                item.classList.add('visited');
                item.scrollIntoView({ block: 'nearest', behavior: reduceMotion ? 'auto' : 'smooth' });
            }
        });

        visited.add(id);
        currentId = id;
        document.body.dataset.currentChapter = id;
        currentHeadings = getHeadingsForChapter(target, id);
        updateProgress();
        updateRail(target, id);
        refreshActiveHeading();

        window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
        history.replaceState(null, '', `#${id}`);
        mainContent.focus({ preventScroll: true });

        sidebar.classList.remove('open');
        mobileBtn.classList.remove('active');
        mobileBtn.setAttribute('aria-expanded', 'false');
    }

    function enhanceChapter(target, chapterId) {
        if (target.dataset.enhanced) return;

        decorateLinks(target);
        installCopyButtons(target);
        wireChapterNavigation(target);
        assignHeadingIds(target, chapterId);
        setupRevealables(target);
        enhanceStories(target);
        enhanceGateSimulators(target);
        enhanceAssemblyExplorers(target);
        enhanceComparisonTables(target);
        enhanceAtlasFilters(target);

        target.dataset.enhanced = '1';
    }

    function decorateLinks(target) {
        target.querySelectorAll('a[href^="http"]').forEach((link) => {
            link.setAttribute('target', '_blank');
            link.setAttribute('rel', 'noreferrer');
            link.classList.add('external-link');
        });
    }

    function installCopyButtons(target) {
        target.querySelectorAll('.code-window').forEach((windowEl) => {
            if (windowEl.dataset.copyReady === '1') return;

            const header = windowEl.querySelector('.window-header');
            const code = windowEl.querySelector('pre code');
            if (!header || !code) return;

            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'copy-btn';
            button.textContent = '複製';
            button.addEventListener('click', async () => {
                try {
                    await navigator.clipboard.writeText(code.textContent || '');
                    flashCopyState(button, '已複製');
                } catch (error) {
                    flashCopyState(button, '失敗');
                }
            });

            header.appendChild(button);
            windowEl.dataset.copyReady = '1';
        });
    }

    function flashCopyState(button, message) {
        const previous = button.textContent;
        button.textContent = message;
        button.disabled = true;

        window.setTimeout(() => {
            button.textContent = previous;
            button.disabled = false;
        }, 1200);
    }

    function wireChapterNavigation(target) {
        target.querySelectorAll('a[href^="#"], .btn[href^="#"]').forEach((link) => {
            link.addEventListener('click', (event) => {
                const href = link.getAttribute('href');
                if (!href || !href.startsWith('#')) return;
                const chapterId = href.slice(1);
                if (!allChapterIds.includes(chapterId)) return;
                event.preventDefault();
                navigateTo(chapterId);
            });
        });
    }

    function assignHeadingIds(target, chapterId) {
        const headings = target.querySelectorAll('.content-body h2, .content-body h3');
        headings.forEach((heading, index) => {
            if (!heading.id) {
                heading.id = `${chapterId}-section-${index + 1}`;
            }
        });
    }

    function setupRevealables(target) {
        const revealables = target.querySelectorAll('.revealable');
        revealables.forEach((element, index) => {
            element.style.setProperty('--reveal-delay', `${(index % 6) * 45}ms`);
        });

        if (reduceMotion || !('IntersectionObserver' in window)) {
            revealables.forEach((element) => element.classList.add('is-visible'));
            return;
        }

        const observer = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (entry.isIntersecting) {
                    entry.target.classList.add('is-visible');
                    observer.unobserve(entry.target);
                }
            });
        }, {
            threshold: 0.18,
            rootMargin: '0px 0px -10% 0px',
        });

        revealables.forEach((element) => observer.observe(element));
    }

    function enhanceStories(target) {
        target.querySelectorAll('[data-story]').forEach((story) => {
            if (story.dataset.ready === '1') return;

            const steps = Array.from(story.querySelectorAll('.story-step'));
            const panels = Array.from(story.querySelectorAll('[data-step-panel]'));

            const activate = (stepId) => {
                steps.forEach((step) => {
                    step.classList.toggle('active', step.dataset.step === stepId);
                });
                panels.forEach((panel) => {
                    panel.classList.toggle('active', panel.dataset.stepPanel === stepId);
                });
            };

            steps.forEach((step) => {
                step.tabIndex = 0;
                step.addEventListener('click', () => activate(step.dataset.step));
                step.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        activate(step.dataset.step);
                    }
                });
            });

            if (!reduceMotion && 'IntersectionObserver' in window) {
                const observer = new IntersectionObserver((entries) => {
                    const visible = entries
                        .filter((entry) => entry.isIntersecting)
                        .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];

                    if (visible) {
                        activate(visible.target.dataset.step);
                    }
                }, {
                    threshold: [0.3, 0.55, 0.8],
                });

                steps.forEach((step) => observer.observe(step));
            }

            if (steps[0]) {
                activate(steps[0].dataset.step);
            }

            story.dataset.ready = '1';
        });
    }

    function enhanceGateSimulators(target) {
        target.querySelectorAll('[data-gate-sim]').forEach((simulator) => {
            if (simulator.dataset.ready === '1') return;

            const buttons = Array.from(simulator.querySelectorAll('.chip[data-group]'));
            const outputList = simulator.querySelector('.gate-results');
            if (!outputList) return;

            const readState = () => {
                const state = {};
                buttons.forEach((button) => {
                    if (button.classList.contains('active')) {
                        state[button.dataset.group] = button.dataset.value;
                    }
                });
                return state;
            };

            const render = () => {
                const state = readState();
                const items = [];
                const trustAllowsProjectConfig = state.trust !== 'untrusted';

                items.push(
                    trustAllowsProjectConfig
                        ? 'Repo instructions、workspace commands、skills 與 workspace provider config 會進入執行前載入。'
                        : '因為工作區不可信，repo instructions、workspace commands、skills 與 workspace provider config 會被擋下。'
                );

                if (state.sandbox === 'read-only') {
                    items.push('讀取型工具仍可用；write_file、apply_patch、shell 會被 sandbox 擋下。');
                } else if (state.sandbox === 'workspace-write') {
                    items.push('讀寫工具可在 workspace 內運作；shell 會直接在主機工作區執行。');
                } else if (state.sandbox === 'container') {
                    items.push('shell 會改走容器執行；其他讀寫工具仍主要依 workspace path 約束，這是目前最值得注意的文實差距。');
                }

                if (state.permission === 'suggest') {
                    items.push('write_file、apply_patch、shell 都會要求確認，適合第一次進陌生專案時使用。');
                } else if (state.permission === 'auto-edit') {
                    items.push('write_file 可直接執行；apply_patch 與 shell 仍會要求確認。');
                } else {
                    items.push('內建 permission gate 不再詢問，僅適合你已明確信任的工作區。');
                }

                if (!trustAllowsProjectConfig && state.permission === 'full-auto') {
                    items.push('即使 permission 開到 full-auto，trust gate 仍會先影響 repo config 是否能被載入。');
                }

                outputList.innerHTML = items.map((item) => `<li>${item}</li>`).join('');
            };

            buttons.forEach((button) => {
                button.addEventListener('click', () => {
                    buttons
                        .filter((candidate) => candidate.dataset.group === button.dataset.group)
                        .forEach((candidate) => candidate.classList.remove('active'));
                    button.classList.add('active');
                    render();
                });
            });

            render();
            simulator.dataset.ready = '1';
        });
    }

    function enhanceAssemblyExplorers(target) {
        target.querySelectorAll('[data-assembly]').forEach((explorer) => {
            if (explorer.dataset.ready === '1') return;

            const tabs = Array.from(explorer.querySelectorAll('[data-assembly-tab]'));
            const panels = Array.from(explorer.querySelectorAll('[data-assembly-panel]'));
            const activate = (name) => {
                tabs.forEach((tab) => {
                    tab.classList.toggle('active', tab.dataset.assemblyTab === name);
                });
                panels.forEach((panel) => {
                    panel.classList.toggle('active', panel.dataset.assemblyPanel === name);
                });
            };

            tabs.forEach((tab) => {
                tab.addEventListener('click', () => activate(tab.dataset.assemblyTab));
            });

            if (tabs[0]) {
                activate(tabs[0].dataset.assemblyTab);
            }

            explorer.dataset.ready = '1';
        });
    }

    function enhanceComparisonTables(target) {
        target.querySelectorAll('.comparison-table').forEach((wrapper) => {
            if (wrapper.dataset.ready === '1') return;

            const table = wrapper.querySelector('table');
            if (!table) return;

            const headerCells = Array.from(table.querySelectorAll('thead th'));
            const rows = Array.from(table.querySelectorAll('tbody tr'));
            if (!headerCells.length) return;

            rows.forEach((row) => {
                Array.from(row.children).forEach((cell, index) => {
                    cell.setAttribute('data-label', headerCells[index] ? headerCells[index].textContent.trim() : '');
                });
            });

            if (headerCells.length > 2) {
                const controls = document.createElement('div');
                controls.className = 'comparison-controls';

                headerCells.slice(1).forEach((header, index) => {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'chip';
                    button.textContent = header.textContent.trim();
                    button.addEventListener('click', () => setFocusedColumn(index + 1, controls));
                    controls.appendChild(button);
                });

                wrapper.insertBefore(controls, table);
                setFocusedColumn(1, controls);
            }

            function setFocusedColumn(columnIndex, controls) {
                table.querySelectorAll('.is-focus').forEach((cell) => cell.classList.remove('is-focus'));
                Array.from(table.rows).forEach((row) => {
                    const cell = row.children[columnIndex];
                    if (cell) {
                        cell.classList.add('is-focus');
                    }
                });

                controls.querySelectorAll('.chip').forEach((button, index) => {
                    button.classList.toggle('active', index === columnIndex - 1);
                });
            }

            wrapper.dataset.ready = '1';
        });
    }

    function enhanceAtlasFilters(target) {
        target.querySelectorAll('[data-filter-target]').forEach((grid) => {
            if (grid.dataset.ready === '1') return;

            const filterName = grid.dataset.filterTarget;
            const scope = grid.parentElement;
            const controls = scope.querySelector(`[data-filter-group="${filterName}"]`);
            const cards = Array.from(grid.querySelectorAll('[data-category]'));
            if (!controls || !cards.length) return;

            const chips = Array.from(controls.querySelectorAll('.chip[data-filter]'));
            const apply = (value) => {
                chips.forEach((chip) => chip.classList.toggle('active', chip.dataset.filter === value));
                cards.forEach((card) => {
                    const visible = value === 'all' || card.dataset.category === value;
                    card.classList.toggle('is-hidden', !visible);
                });
            };

            chips.forEach((chip) => {
                chip.addEventListener('click', () => apply(chip.dataset.filter));
            });

            apply('all');
            grid.dataset.ready = '1';
        });
    }

    function getHeadingsForChapter(target, chapterId) {
        if (!target.dataset.loaded) return [];

        return Array.from(target.querySelectorAll('.content-body h2, .content-body h3')).map((heading, index) => ({
            id: heading.id || `${chapterId}-section-${index + 1}`,
            title: heading.textContent.trim(),
            level: heading.tagName.toLowerCase(),
            element: heading,
        }));
    }

    function updateRail(target, id) {
        const item = chapterIndex.get(id);
        const title = target.querySelector('.chapter-header h1')?.textContent?.trim()
            || target.querySelector('.hero-title')?.textContent?.replace(/\s+/g, ' ').trim()
            || item?.label
            || '章節';
        const body = target.querySelector('.content-body') || target;
        const charCount = body.textContent.replace(/\s+/g, '').length;
        const readMinutes = Math.max(1, Math.round(charCount / 760));
        const sectionCount = currentHeadings.filter((heading) => heading.level === 'h2').length || currentHeadings.length;
        const externalCount = target.querySelectorAll('a[href^="http"]').length;

        railTitle.textContent = title;
        railMeta.textContent = `約 ${readMinutes} 分鐘 · ${sectionCount} 個段落 · ${externalCount} 個外部來源`;

        if (!currentHeadings.length) {
            chapterToc.innerHTML = '<span class="toc-empty">這一章以總覽內容為主，目前沒有額外的小節導覽。</span>';
            return;
        }

        chapterToc.innerHTML = currentHeadings.map((heading) => `
            <button type="button" class="toc-item toc-${heading.level}" data-heading-id="${heading.id}">
                ${heading.title}
            </button>
        `).join('');

        chapterToc.querySelectorAll('.toc-item').forEach((button) => {
            button.addEventListener('click', () => {
                const heading = document.getElementById(button.dataset.headingId);
                if (!heading) return;
                heading.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
            });
        });
    }

    function refreshActiveHeading() {
        backToTop.classList.toggle('visible', window.scrollY > 420);

        if (!currentHeadings.length) return;

        const threshold = 150;
        let activeId = currentHeadings[0].id;

        for (const heading of currentHeadings) {
            const top = heading.element.getBoundingClientRect().top;
            if (top <= threshold) {
                activeId = heading.id;
            } else {
                break;
            }
        }

        chapterToc.querySelectorAll('.toc-item').forEach((button) => {
            button.classList.toggle('active', button.dataset.headingId === activeId);
        });
    }

    function updateProgress() {
        const chapterNumber = currentId ? allChapterIds.indexOf(currentId) + 1 : 0;
        const scrollable = document.documentElement.scrollHeight - window.innerHeight;
        const chapterProgress = scrollable > 0 ? Math.min(100, Math.max(0, Math.round((window.scrollY / scrollable) * 100))) : 0;

        progressBar.style.width = `${chapterProgress}%`;
        progressText.textContent = totalChapters
            ? `第 ${chapterNumber || 1} / ${totalChapters} 章 · 已讀 ${visited.size} 章 · 章內 ${chapterProgress}%`
            : '載入章節中…';
    }

    function bindGlobalEvents() {
        searchInput.addEventListener('input', () => {
            const query = searchInput.value.toLowerCase().trim();
            sidebarNav.querySelectorAll('.nav-item').forEach((item) => {
                const text = item.textContent.toLowerCase();
                item.classList.toggle('search-hidden', query !== '' && !text.includes(query));
            });
        });

        mobileBtn.addEventListener('click', () => {
            const open = !sidebar.classList.contains('open');
            sidebar.classList.toggle('open', open);
            mobileBtn.classList.toggle('active', open);
            mobileBtn.setAttribute('aria-expanded', String(open));
        });

        mainContent.addEventListener('click', () => {
            if (window.innerWidth <= 920) {
                sidebar.classList.remove('open');
                mobileBtn.classList.remove('active');
                mobileBtn.setAttribute('aria-expanded', 'false');
            }
        });

        window.addEventListener('scroll', () => {
            refreshActiveHeading();
            updateProgress();
        }, { passive: true });

        window.addEventListener('resize', updateProgress);

        backToTop.addEventListener('click', () => {
            window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
        });

        window.addEventListener('popstate', () => {
            const hash = window.location.hash.slice(1);
            if (hash && allChapterIds.includes(hash)) {
                navigateTo(hash);
            }
        });

        document.addEventListener('keydown', (event) => {
            if (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
                return;
            }

            const index = allChapterIds.indexOf(currentId);

            if ((event.key === 'ArrowRight' || event.key === 'ArrowDown') && index < allChapterIds.length - 1) {
                event.preventDefault();
                navigateTo(allChapterIds[index + 1]);
            } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowUp') && index > 0) {
                event.preventDefault();
                navigateTo(allChapterIds[index - 1]);
            } else if (event.key === '/' && !event.ctrlKey && !event.metaKey) {
                event.preventDefault();
                searchInput.focus();
            } else if (event.key === 'Escape') {
                searchInput.value = '';
                searchInput.dispatchEvent(new Event('input'));
                searchInput.blur();
                sidebar.classList.remove('open');
                mobileBtn.classList.remove('active');
                mobileBtn.setAttribute('aria-expanded', 'false');
            }
        });
    }

    function bindPointerTracking() {
        if (reduceMotion) return;

        window.addEventListener('pointermove', (event) => {
            if (pointerFrame) return;

            pointerFrame = window.requestAnimationFrame(() => {
                const x = `${(event.clientX / window.innerWidth) * 100}%`;
                const y = `${(event.clientY / window.innerHeight) * 100}%`;
                document.documentElement.style.setProperty('--pointer-x', x);
                document.documentElement.style.setProperty('--pointer-y', y);
                pointerFrame = null;
            });
        }, { passive: true });
    }

    function escapeHtml(value) {
        return String(value)
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
            .replaceAll("'", '&#39;');
    }

    window.navigateTo = navigateTo;
})();
