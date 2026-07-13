/**
 * AUTO-GENERATED FILE - DO NOT EDIT MANUALLY
 * Generated on: 2026-07-13T14:25:24.554Z
 */

export const DEFAULT_FILES: Record<string, string> = {
  "apps/notes.html": `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Notes</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>
    <!-- MathJax -->
    <script>
    window.MathJax = {
      tex: { inlineMath: [['$', '$'], ['\\\\(', '\\\\)']] },
      svg: { fontCache: 'global' }
    };
    </script>
    <script id="MathJax-script" async src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
    <script src="../system/lib/ui.js"></script>
    <script src="../system/lib/std.js"></script>
    <style>
        .prose h1, .prose h2, .prose h3 { color: rgb(var(--c-text-main)); font-weight: 700; margin-top: 1.5em; margin-bottom: 0.5em; }
        .prose h1 { font-size: 1.75em; border-bottom: 1px solid rgb(var(--c-border-main)); padding-bottom: 0.3em; }
        .prose p { margin-bottom: 1em; line-height: 1.7; color: rgb(var(--c-text-main)); opacity: 0.9; }
        .prose ul { list-style: disc; padding-left: 1.5em; color: rgb(var(--c-text-muted)); }
        .prose ol { list-style: decimal; padding-left: 1.5em; color: rgb(var(--c-text-muted)); }
        .prose code { background: rgb(var(--c-bg-hover)); padding: 0.2em 0.4em; rounded: 0.25em; font-family: monospace; color: rgb(var(--c-accent-primary)); }
        .prose pre { background: rgb(var(--c-bg-app)); padding: 1em; border-radius: 0.5em; overflow: auto; border: 1px solid rgb(var(--c-border-main)); }
        .prose blockquote { border-left: 4px solid rgb(var(--c-border-highlight)); padding-left: 1em; color: rgb(var(--c-text-muted)); font-style: italic; }
        .prose a { color: rgb(var(--c-accent-primary)); text-decoration: underline; }
    </style>
</head>
<body class="bg-app text-text-main h-screen flex overflow-hidden relative">

    <div id="sidebar-overlay" onclick="toggleSidebar()" class="fixed inset-0 bg-black/50 z-30 hidden lg:hidden opacity-0 transition-opacity duration-300"></div>

    <aside id="sidebar" class="absolute lg:relative w-72 h-full bg-panel border-r border-border-main flex flex-col shrink-0 z-40 transform -translate-x-full lg:translate-x-0 transition-transform duration-300 shadow-2xl lg:shadow-none">
        <div class="h-14 flex items-center justify-between px-4 border-b border-border-main shrink-0">
            <div class="flex items-center gap-2">
                <button onclick="AppUI.home()" class="text-text-muted hover:text-text-main transition p-1 rounded hover:bg-hover"><svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg></button>
                <span class="font-bold tracking-tight">Data Tree</span>
            </div>
            <div class="flex gap-1 items-center">
                <button onclick="openDailyNote()" class="text-text-main hover:text-primary text-sm font-bold bg-panel border border-border-main hover:border-primary/50 px-2 py-1 rounded transition" title="Open Today's Journal">📝 Today</button>
                <button onclick="newNote()" class="text-primary hover:text-primary/80 text-sm font-bold bg-primary/10 px-2 py-1 rounded transition">+ New</button>
                <button onclick="toggleSidebar()" class="lg:hidden text-text-muted hover:text-text-main p-1 rounded hover:bg-hover">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"></path></svg>
                </button>
            </div>
        </div>
        
        <div class="p-3 border-b border-border-main/50 bg-panel/50 backdrop-blur shrink-0 z-10 sticky top-0">
            <div class="relative">
                <svg class="w-4 h-4 absolute left-3 top-2.5 text-text-muted opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path></svg>
                <input type="text" id="search-input" placeholder="Search data..." class="w-full bg-card border border-border-main rounded-lg pl-9 pr-3 py-2 text-sm text-text-main focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition-all placeholder-text-muted">
            </div>
        </div>

        <div id="file-list" class="flex-1 overflow-y-auto p-2 space-y-0.5 pb-20">
            <div class="text-xs text-center text-text-muted py-4">Loading tree...</div>
        </div>
    </aside>

    <main class="flex-1 flex flex-col bg-app relative min-w-0">
        <header class="h-14 border-b border-border-main flex items-center justify-between px-4 bg-panel shrink-0 z-10">
            <div class="flex items-center gap-3 min-w-0">
                <button onclick="toggleSidebar()" class="p-1.5 rounded-lg text-text-muted hover:text-text-main hover:bg-hover transition bg-card border border-border-main lg:hidden">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"></path></svg>
                </button>
                <button onclick="toggleSidebar()" class="hidden lg:block p-1.5 rounded-lg text-text-muted hover:text-text-main hover:bg-hover transition" title="Toggle Sidebar">
                    <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h7"></path></svg>
                </button>
                <h2 id="note-title" class="font-bold truncate text-text-main text-sm">Welcome</h2>
            </div>
            
            <div id="editor-toolbar" class="hidden items-center gap-3 shrink-0 pl-4">
                <span id="status-indicator" class="text-[10px] text-text-muted font-mono uppercase tracking-widest hidden sm:inline-block">Synced</span>
                
                <div class="bg-card border border-border-main rounded-lg p-0.5 flex text-xs font-medium">
                    <button id="btn-view" onclick="setMode('view')" class="px-3 py-1.5 rounded-md bg-panel text-text-main shadow-sm transition">View</button>
                    <button id="btn-edit" onclick="setMode('edit')" class="px-3 py-1.5 rounded-md text-text-muted hover:text-text-main transition">Edit</button>
                </div>

                <button onclick="openInMonaco()" class="text-text-muted hover:text-primary p-1.5 rounded transition" title="Open in Code Editor (Host)">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"></path></svg>
                </button>
            </div>
        </header>

        <div id="empty-state" class="absolute inset-0 flex items-center justify-center text-text-muted flex-col pointer-events-none mt-14">
            <svg class="w-16 h-16 mb-4 opacity-20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
            <p class="font-medium">Select a file from the tree</p>
            <p class="text-xs opacity-60 mt-1">Markdown files in data/ directory</p>
        </div>

        <div id="content-view" class="hidden flex-1 relative overflow-hidden">
            <div id="markdown-viewer" class="absolute inset-0 overflow-y-auto p-4 md:p-8 scroll-smooth">
                <article id="markdown-body" class="prose max-w-3xl mx-auto pb-20"></article>
            </div>
            <div id="markdown-editor-container" class="hidden absolute inset-0 bg-app">
                <textarea id="markdown-editor" class="w-full h-full bg-transparent text-text-main p-4 md:p-8 focus:outline-none resize-none font-mono text-sm leading-relaxed" spellcheck="false" placeholder="Start writing..."></textarea>
            </div>
        </div>
    </main>

    <script>
        let currentPath = null;
        let allFiles = [];
        let currentMode = 'view';
        let fileContent = '';

        function toggleSidebar() {
            const sidebar = document.getElementById('sidebar');
            const overlay = document.getElementById('sidebar-overlay');
            if (window.innerWidth < 1024) {
                if (sidebar.classList.contains('-translate-x-full')) {
                    sidebar.classList.remove('-translate-x-full');
                    overlay.classList.remove('hidden');
                    setTimeout(() => overlay.classList.remove('opacity-0'), 10);
                } else {
                    sidebar.classList.add('-translate-x-full');
                    overlay.classList.add('opacity-0');
                    setTimeout(() => overlay.classList.add('hidden'), 300);
                }
            } else {
                if (sidebar.classList.contains('lg:translate-x-0')) {
                    sidebar.classList.remove('lg:translate-x-0');
                    sidebar.classList.add('-translate-x-full', 'hidden');
                } else {
                    sidebar.classList.remove('-translate-x-full', 'hidden');
                    sidebar.classList.add('lg:translate-x-0');
                }
            }
        }

        async function init() {
            await loadList();
            
            // V2: OSから渡された引数を受け取る
            const args = await App.Context.getArgs();

            // 'file' 引数でパスが渡されていればそれを開く。なければ空のノートで立ち上がる。
            if (args.file) {
                openNote(args.file);
            }
        }

        async function loadList() {
            try {
                // V2: MetaOS.fs.list
                const files = await MetaOS.fs.list('data', { recursive: true });
                if (Array.isArray(files)) {
                    allFiles = files.filter(f => {
                        const pathStr = typeof f === 'object' ? f.path : f;
                        return pathStr.endsWith('.md') && !pathStr.includes('.git');
                    }).map(f => typeof f === 'object' ? f.path : f).sort();
                } else {
                    allFiles = [];
                }
                renderTree(allFiles);
            } catch(e) {
                document.getElementById('file-list').innerHTML = \`<div class="text-error text-xs p-2">Error: \${e.message}</div>\`;
            }
        }

        function renderTree(files) {
            const container = document.getElementById('file-list');
            const query = document.getElementById('search-input').value.toLowerCase();
            const filtered = files.filter(p => p.toLowerCase().includes(query));

            if (!filtered.length) return container.innerHTML = '<div class="text-text-muted text-xs text-center py-4">No matching files.</div>';

            const tree = filtered.reduce((acc, path) => {
                path.replace(/^data\\//, '').split('/').reduce((node, part, i, arr) => 
                    node[part] = node[part] ?? (i === arr.length - 1 ? path : {}), acc);
                return acc;
            }, {});

            container.innerHTML = '';
            container.appendChild(renderTreeLevel(tree, 0, ''));
        }

        function renderTreeLevel(node, depth = 0, parentPath = '') {
            const ul = document.createElement('div');
            ul.className = depth > 0 ? "border-l border-border-main/50 ml-3 pl-1 space-y-0.5" : "space-y-0.5";
            
            const keys = Object.keys(node).sort((a, b) => {
                const isAFolder = typeof node[a] === 'object';
                const isBFolder = typeof node[b] === 'object';
                if (isAFolder && !isBFolder) return -1;
                if (!isAFolder && isBFolder) return 1;
                return a.localeCompare(b);
            });

            keys.forEach(key => {
                const value = node[key];
                if (typeof value === 'object') {
                    const folderPath = parentPath ? \`\${parentPath}/\${key}\` : key;
                    const details = document.createElement('details');
                    
                    const openFolders = JSON.parse(localStorage.getItem('metaos_tree_open_folders') || '[]');
                    details.open = openFolders.includes(folderPath);
                    
                    details.addEventListener('toggle', (e) => {
                        const currentOpen = JSON.parse(localStorage.getItem('metaos_tree_open_folders') || '[]');
                        if (details.open) {
                            if (!currentOpen.includes(folderPath)) currentOpen.push(folderPath);
                        } else {
                            const idx = currentOpen.indexOf(folderPath);
                            if (idx > -1) currentOpen.splice(idx, 1);
                        }
                        localStorage.setItem('metaos_tree_open_folders', JSON.stringify(currentOpen));
                    });

                    const summary = document.createElement('summary');
                    summary.className = "cursor-pointer px-2 py-1.5 text-[10px] font-bold text-text-muted hover:text-text-main uppercase tracking-wider flex items-center gap-1.5 select-none group rounded hover:bg-hover";
                    summary.innerHTML = \`
                        <svg class="w-3 h-3 text-text-muted group-hover:text-text-main transition transform group-open:rotate-90 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"></path></svg>
                        <svg class="w-3.5 h-3.5 text-warning/70 group-hover:text-warning shrink-0" fill="currentColor" viewBox="0 0 24 24"><path d="M4 4c0-1.1.9-2 2-2h4.59L12 4h6c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H6c-1.1 0-2-.9-2-2V4z"/></svg>
                        <span class="truncate">\${key}</span>
                    \`;
                    details.appendChild(summary);
                    details.appendChild(renderTreeLevel(value, depth + 1, folderPath));
                    ul.appendChild(details);
                } else {
                    const path = value;
                    const isActive = currentPath === path;
                    const div = document.createElement('div');
                    div.className = \`cursor-pointer px-2 py-1.5 text-[13px] rounded-md truncate transition flex items-center gap-2 mt-0.5 \${isActive ? 'bg-primary/10 text-primary font-medium border border-primary/20' : 'text-text-muted hover:bg-hover hover:text-text-main border border-transparent'}\`;
                    
                    div.onclick = () => {
                        openNote(path);
                        if (window.innerWidth < 1024) toggleSidebar(); 
                    };
                    
                    div.title = key;
                    div.innerHTML = \`
                        <svg class="w-3.5 h-3.5 opacity-50 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"></path></svg>
                        <span class="truncate">\${key.replace('.md', '')}</span>
                    \`;
                    ul.appendChild(div);
                }
            });
            return ul;
        }

        function setMode(mode) {
            currentMode = mode;
            const btnView = document.getElementById('btn-view');
            const btnEdit = document.getElementById('btn-edit');
            const viewer = document.getElementById('markdown-viewer');
            const editor = document.getElementById('markdown-editor-container');
            const textarea = document.getElementById('markdown-editor');

            if (mode === 'edit') {
                btnView.className = "px-3 py-1.5 rounded-md text-text-muted hover:text-text-main transition";
                btnEdit.className = "px-3 py-1.5 rounded-md bg-panel text-text-main shadow-sm transition";
                viewer.classList.add('hidden');
                editor.classList.remove('hidden');
                textarea.value = fileContent;
                textarea.focus();
            } else {
                btnEdit.className = "px-3 py-1.5 rounded-md text-text-muted hover:text-text-main transition";
                btnView.className = "px-3 py-1.5 rounded-md bg-panel text-text-main shadow-sm transition";
                editor.classList.add('hidden');
                viewer.classList.remove('hidden');
                
                if (textarea.value !== fileContent) {
                    fileContent = textarea.value;
                    saveContent();
                }
                renderMarkdown(fileContent);
            }
        }

        async function openNote(path) {
            currentPath = path;
            renderTree(allFiles); 
            
            document.getElementById('empty-state').classList.add('hidden');
            document.getElementById('content-view').classList.remove('hidden');
            document.getElementById('editor-toolbar').classList.remove('hidden');
            document.getElementById('editor-toolbar').classList.add('flex');
            document.getElementById('note-title').textContent = path.split('/').pop();
            
            const status = document.getElementById('status-indicator');
            status.textContent = "Loading...";
            
            const body = document.getElementById('markdown-body');
            body.innerHTML = '<div class="animate-pulse space-y-4 pt-4"><div class="h-8 bg-panel rounded w-1/3 mb-6"></div><div class="h-4 bg-panel rounded w-full"></div><div class="h-4 bg-panel rounded w-5/6"></div></div>';

            try {
                // V2 API
                fileContent = await MetaOS.fs.read(path);
                
                renderMarkdown(fileContent);
                status.textContent = "Synced";

                if (currentMode === 'edit') {
                    document.getElementById('markdown-editor').value = fileContent;
                }
            } catch(e) {
                body.innerHTML = \`<div class="text-error p-4 border border-error/50 rounded bg-error/10">Failed to load: \${e.message}</div>\`;
                status.textContent = "Error";
            }
        }

        function renderMarkdown(content) {
            const body = document.getElementById('markdown-body');
            try {
                const mathBlocks = [];
                const protectedContent = content.replace(/\\$\\$([\\s\\S]+?)\\$\\$/g, (m) => { mathBlocks.push(m); return \`MATHBLOCK\${mathBlocks.length-1}END\`; })
                                                .replace(/\\$([^$]+?)\\$/g, (m) => { mathBlocks.push(m); return \`MATHINLINE\${mathBlocks.length-1}END\`; });

                let html = marked.parse(protectedContent);
                
                html = html.replace(/MATHBLOCK(\\d+)END/g, (m, id) => mathBlocks[parseInt(id)])
                           .replace(/MATHINLINE(\\d+)END/g, (m, id) => mathBlocks[parseInt(id)]);

                body.innerHTML = html;

                if (window.MathJax) {
                    MathJax.typesetPromise([body]).then(() => {});
                }
            } catch (e) {
                body.innerHTML = \`<div class="text-error">Markdown render error</div>\`;
            }
        }

        const setStatus = (msg, state = '') => {
            const el = document.getElementById('status-indicator');
            el.textContent = msg;
            el.className = \`text-[10px] font-mono uppercase tracking-widest hidden sm:inline-block \${state === 'warn' ? 'text-warning' : state === 'err' ? 'text-error' : 'text-text-muted'}\`;
        };

        const debounce = (fn, ms) => { let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; };

        const saveContent = async () => {
            if (!currentPath) return;
            setStatus("Saving...", "warn");
            try {
                // V2 API: overwrite option required
                await MetaOS.fs.write(currentPath, fileContent, { overwrite: true, silent: true });
                setStatus("Saved");
                setTimeout(() => setStatus("Synced"), 2000);
            } catch { setStatus("Error", "err"); }
        };

        const autoSave = debounce(saveContent, 1000);

        document.getElementById('markdown-editor').addEventListener('input', e => {
            fileContent = e.target.value;
            setStatus("Editing...", "warn");
            autoSave();
        });

        document.addEventListener('keydown', (e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                if (currentMode === 'edit') saveContent();
            }
        });

        async function openDailyNote() {
            const now = new Date();
            const yyyy = now.getFullYear();
            const mm = String(now.getMonth() + 1).padStart(2, '0');
            const dd = String(now.getDate()).padStart(2, '0');
            const filename = \`\${yyyy}-\${mm}-\${dd}.md\`;
            const path = \`data/notes/journal/\${filename}\`;

            if (!allFiles.includes(path)) {
                await MetaOS.fs.write(path, \`# \${yyyy}-\${mm}-\${dd}\\n\\n\`, { overwrite: true });
                if (!allFiles.includes(path)) allFiles.push(path);
                renderTree(allFiles);
            }
            openNote(path);
            
            if (window.innerWidth < 1024) toggleSidebar();
        }

        async function newNote() {
            const name = prompt("Enter file name (e.g. 'notes/Meeting.md' or 'projects/Design.md'):\\nDefault goes to 'data/notes/'", "Untitled.md");
            if(!name) return;
            
            let path = name;
            if (!path.includes('/')) {
                path = \`data/notes/\${path}\`;
            } else if (!path.startsWith('data/')) {
                path = \`data/\${path}\`;
            }
            if (!path.endsWith('.md')) path += '.md';

            await MetaOS.fs.write(path, \`# \${path.split('/').pop().replace('.md','')}\\n\\nStart writing...\`, { overwrite: true });
            App.AI.logEvent(\`User created a new note: "\${path}"\`, 'note_created');
        }

        function openInMonaco() {
            if(currentPath) MetaOS.host.openEditor(currentPath);
        }

        document.getElementById('search-input').addEventListener('input', () => renderTree(allFiles));

        if (window.MetaOS && MetaOS.system.on) {
            // 他のアプリからのOSレベルのイベントを購読
            MetaOS.system.on('file_changed', (payload) => {
                if (payload.path.startsWith('data/notes') || payload.path.startsWith('data/')) {
                     loadList().then(() => {
                         if(currentPath && payload.path === currentPath) {
                             if (currentMode !== 'edit') {
                                 openNote(currentPath);
                             }
                         }
                     });
                }
            });

            // OSから「別のファイルを開け」と要求された時の処理 (Resume対応)
            MetaOS.system.on('route_changed', (payload) => {
                if (payload && payload.args && payload.args.file) {
                    openNote(payload.args.file);
                }
            });
        }

        init();
    </script>
</body>
</html>`.trim(),

  "data/": "",

  "docs/": "",

  "index.html": `
<!-- vfs_root/index.html -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Itera OS v2 Dashboard</title>
</head>
<body class="bg-app text-text-main p-8 flex flex-col items-center justify-center h-screen font-sans">
  <div class="text-6xl mb-4">✨</div>
  <h1 class="text-3xl font-bold mb-2">Itera OS v2</h1>
  <p class="text-text-muted">The core system has been successfully initialized.</p>
  <p class="text-xs text-text-muted mt-8 font-mono opacity-50">VFS & IPC Subsystems Active</p>
</body>
</html>`.trim(),

  "system/apps/settings.html": `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Settings</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <script src="/system/lib/ui.js"></script>
    <script src="/system/lib/std.js"></script>
    <style>
        /* Hide scrollbar for clean OS look */
        .no-scrollbar::-webkit-scrollbar { display: none; }
        .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
    </style>
</head>
<body class="bg-app text-text-main h-screen flex flex-col overflow-hidden">

    <!-- Header -->
    <header class="h-14 border-b border-border-main flex items-center justify-between px-6 bg-panel shrink-0 z-10 sticky top-0 shadow-sm">
        <div class="flex items-center gap-4">
            <button onclick="AppUI.home()" class="p-1.5 -ml-1.5 rounded-lg text-text-muted hover:text-text-main hover:bg-hover transition bg-card border border-border-main">
                <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>
            </button>
            <h1 class="text-lg font-bold tracking-tight">System Settings</h1>
        </div>
        <div class="flex items-center gap-2">
            <span id="save-status" class="text-[10px] text-text-muted font-mono uppercase tracking-widest opacity-0 transition-opacity">Saved</span>
        </div>
    </header>

    <!-- Content -->
    <main class="flex-1 overflow-y-auto no-scrollbar p-6">
        <div class="max-w-3xl mx-auto space-y-8 pb-10">

            <!-- Profile & Agent -->
            <section class="bg-panel rounded-2xl border border-border-main p-6 shadow-sm">
                <div class="flex items-center gap-3 mb-6 pb-4 border-b border-border-main/50">
                    <div class="w-8 h-8 rounded-full bg-primary/20 text-primary flex items-center justify-center">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"></path></svg>
                    </div>
                    <div>
                        <h2 class="text-sm font-bold uppercase tracking-wider text-text-main">Identity & Localization</h2>
                        <p class="text-xs text-text-muted">User and Assistant profiles.</p>
                    </div>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div>
                        <label class="block text-xs font-bold text-text-muted uppercase mb-1.5">User Name</label>
                        <input type="text" id="config-username" data-key="preferences.username" class="w-full bg-card border border-border-main rounded-lg px-3 py-2 text-sm text-text-main focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition shadow-inner">
                    </div>
                    <div>
                        <label class="block text-xs font-bold text-text-muted uppercase mb-1.5">Agent Name</label>
                        <input type="text" id="config-agentName" data-key="preferences.agentName" class="w-full bg-card border border-border-main rounded-lg px-3 py-2 text-sm text-text-main focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition shadow-inner">
                    </div>
                    <div class="md:col-span-2">
                        <label class="block text-xs font-bold text-text-muted uppercase mb-1.5">Language</label>
                        <select id="config-language" data-key="preferences.language" class="w-full md:w-1/2 bg-card border border-border-main rounded-lg px-3 py-2 text-sm text-text-main focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition cursor-pointer">
                            <option value="English">English</option>
                            <option value="Japanese">Japanese (日本語)</option>
                            <option value="Spanish">Spanish (Español)</option>
                            <option value="French">French (Français)</option>
                            <option value="German">German (Deutsch)</option>
                            <option value="Chinese (Simplified)">Chinese Simplified (简体中文)</option>
                            <option value="Chinese (Traditional)">Chinese Traditional (繁體中文)</option>
                            <option value="Korean">Korean (한국어)</option>
                            <option value="Portuguese">Portuguese (Português)</option>
                            <option value="Russian">Russian (Русский)</option>
                            <option value="Arabic">Arabic (العربية)</option>
                            <option value="Hindi">Hindi (हिन्दी)</option>
                        </select>
                    </div>
                </div>
            </section>

            <!-- System & LLM -->
            <section class="bg-panel rounded-2xl border border-border-main p-6 shadow-sm">
                <div class="flex items-center gap-3 mb-6 pb-4 border-b border-border-main/50">
                    <div class="w-8 h-8 rounded-full bg-warning/20 text-warning flex items-center justify-center">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"></path></svg>
                    </div>
                    <div>
                        <h2 class="text-sm font-bold uppercase tracking-wider text-text-main">AI Engine (LLM)</h2>
                        <p class="text-xs text-text-muted">Configure the autonomous brain of the OS.</p>
                    </div>
                </div>

                <div class="space-y-6">
                    <div>
                        <label class="block text-xs font-bold text-text-muted uppercase mb-1.5">CORS Proxy URL</label>
                        <input type="text" id="config-network-proxyUrl" data-key="network.proxyUrl" class="w-full font-mono bg-card border border-border-main rounded-lg px-3 py-2 text-sm text-text-main focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition shadow-inner" placeholder="https://corsproxy.io/?">
                        <p class="text-[10px] text-text-muted mt-1.5 opacity-80">Prefix used when 'useProxy' is true. Example: http://localhost:8080/?</p>
                    </div>
                    
                    <div class="flex items-center gap-3 bg-card/50 p-3 rounded-lg border border-border-main/50">
                        <input type="checkbox" id="config-network-allowCredentialsWithProxy" data-key="network.allowCredentialsWithProxy" class="w-4 h-4 rounded border-border-main text-primary focus:ring-primary cursor-pointer">
                        <div>
                            <label for="config-network-allowCredentialsWithProxy" class="block text-xs font-bold text-text-main cursor-pointer">Allow Credentials with Proxy</label>
                            <p class="text-[10px] text-text-muted mt-0.5">⚠️ Enable this ONLY if you are using a trusted local proxy. Sending API keys to public proxies is dangerous.</p>
                        </div>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                            <label class="block text-xs font-bold text-text-muted uppercase mb-1.5">Provider</label>
                            <select id="ui-provider-select" class="w-full bg-card border border-border-main rounded-lg px-3 py-2 text-sm text-text-main focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition cursor-pointer">
                                <option value="">Loading...</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-xs font-bold text-text-muted uppercase mb-1.5">Model Name</label>
                            <input type="text" list="model-list" id="ui-model-input" class="w-full font-mono bg-card border border-border-main rounded-lg px-3 py-2 text-sm text-text-main focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition shadow-inner" placeholder="Type or select model...">
                            <datalist id="model-list"></datalist>
                        </div>
                    </div>
                    
                    <div id="llm-capabilities-panel" class="bg-card/30 border border-border-main rounded-lg p-3 hidden transition-all">
                        <div class="flex justify-between items-start mb-2">
                            <h3 id="cap-model-name" class="text-xs font-bold text-text-main uppercase tracking-wider">Model Name</h3>
                            <span id="cap-context" class="text-[10px] text-text-muted font-mono bg-panel px-1.5 py-0.5 rounded border border-border-main">-- Tokens</span>
                        </div>
                        
                        <div class="flex flex-wrap gap-2 mb-3" id="cap-badges">
                            <!-- Badges injected here -->
                        </div>

                        <div id="cap-pricing" class="text-[10px] text-text-muted font-mono flex gap-4">
                            <!-- Pricing injected here -->
                        </div>
                    </div>
                </div>
            </section>

            <!-- Appearance (Themes) -->
            <section class="bg-panel rounded-2xl border border-border-main p-6 shadow-sm">
                <div class="flex items-center gap-3 mb-6 pb-4 border-b border-border-main/50">
                    <div class="w-8 h-8 rounded-full bg-success/20 text-success flex items-center justify-center">
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01"></path></svg>
                    </div>
                    <div>
                        <h2 class="text-sm font-bold uppercase tracking-wider text-text-main">Appearance</h2>
                        <p class="text-xs text-text-muted">Customize the visual theme of the interface.</p>
                    </div>
                </div>

                <div id="theme-list" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
                    <div class="text-text-muted text-sm animate-pulse">Loading themes...</div>
                </div>

                <div class="border-t border-border-main/50 pt-6">
                    <h3 class="text-xs font-bold text-text-main uppercase tracking-wider mb-4">Typography & Layout</h3>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div>
                            <label class="block text-xs font-bold text-text-muted uppercase mb-1.5">UI Font</label>
                            <select id="config-app-uifont" data-key="appearance.typography.uiFont" class="w-full bg-card border border-border-main rounded-lg px-3 py-2 text-sm text-text-main focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition cursor-pointer">
                                <option value="Inter">Inter (Default)</option>
                                <option value="system-ui">System Default</option>
                                <option value="Roboto">Roboto</option>
                                <option value="Helvetica">Helvetica</option>
                                <option value="sans-serif">Sans Serif</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-xs font-bold text-text-muted uppercase mb-1.5">Editor / Terminal Font</label>
                            <select id="config-app-monofont" data-key="appearance.typography.monoFont" class="w-full bg-card border border-border-main rounded-lg px-3 py-2 text-sm text-text-main focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition cursor-pointer">
                                <option value="monospace">Monospace (Default)</option>
                                <option value="Fira Code">Fira Code</option>
                                <option value="JetBrains Mono">JetBrains Mono</option>
                                <option value="Consolas">Consolas</option>
                                <option value="Courier New">Courier New</option>
                            </select>
                        </div>
                        <div>
                            <label class="block text-xs font-bold text-text-muted uppercase mb-1.5">Global UI Scale</label>
                            <select id="config-app-fontsize" data-key="appearance.typography.fontSize" class="w-full bg-card border border-border-main rounded-lg px-3 py-2 text-sm text-text-main focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary/30 transition cursor-pointer">
                                <option value="small">Small</option>
                                <option value="medium">Medium (Default)</option>
                                <option value="large">Large</option>
                                <option value="x-large">Extra Large</option>
                            </select>
                        </div>
                        <div class="flex items-center gap-3 pt-6">
                            <input type="checkbox" id="config-app-animations" data-key="appearance.layout.animations" class="w-4 h-4 rounded border-border-main text-primary focus:ring-primary cursor-pointer">
                            <div>
                                <label for="config-app-animations" class="block text-xs font-bold text-text-main cursor-pointer">Enable Animations</label>
                                <p class="text-[10px] text-text-muted mt-0.5">Uncheck to reduce motion</p>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            <!-- System Info Footer -->
            <div class="text-center pt-4 pb-8">
                <p class="text-xs font-bold text-text-main tracking-widest uppercase">Itera OS v2</p>
                <p class="text-[10px] text-text-muted opacity-50 mt-1 font-mono">Kernel: Guest Bridge (window.MetaOS)</p>
            </div>

        </div>
    </main>

    <script>
        // V2 分散設定用の状態管理
        let prefsConfig = {};
        let llmConfig = {};
        let networkConfig = {};
        let appearanceConfig = {};

        // 差分検知用
        let oldPrefsConfig = {};

        // LLM レジストリ状態
        let llmProfiles = { providers: [] };
        let currentProviderId = "google";
        
        const DOM = id => document.getElementById(id);
        
        // --- Boot & Load ---
        async function init() {
            if (!window.MetaOS) return setTimeout(init, 50);

            try {
                prefsConfig = await App.Config.get('preferences');
                llmConfig = await App.Config.get('llm');
                networkConfig = await App.Config.get('network');
                appearanceConfig = await App.Config.get('appearance');

                oldPrefsConfig = JSON.parse(JSON.stringify(prefsConfig));
                
                // Bind values to UI
                DOM('config-username').value = prefsConfig.username || '';
                DOM('config-agentName').value = prefsConfig.agentName || '';
                DOM('config-language').value = prefsConfig.language || 'English';
                DOM('config-network-proxyUrl').value = networkConfig.proxyUrl || '';
                DOM('config-network-allowCredentialsWithProxy').checked = !!networkConfig.allowCredentialsWithProxy;

                DOM('config-app-uifont').value = appearanceConfig.typography?.uiFont || 'Inter';
                DOM('config-app-monofont').value = appearanceConfig.typography?.monoFont || 'monospace';
                DOM('config-app-fontsize').value = appearanceConfig.typography?.fontSize || 'medium';
                DOM('config-app-animations').checked = appearanceConfig.layout?.animations !== false;

                await loadLlmProfiles(llmConfig.model || 'gemini-3-flash-preview');
                await loadThemes();
            } catch (e) {
                console.warn("Failed to load config", e);
            }
        }

        // --- Save & Sync ---
        async function saveConfig() {
            const status = DOM('save-status');
            status.textContent = "Saving...";
            status.classList.remove('opacity-0');
            status.classList.add('text-warning');

            try {
                // 各カテゴリごとに保存 (V2仕様)
                await App.Config.update('preferences', prefsConfig);
                await App.Config.update('llm', llmConfig);
                await App.Config.update('network', networkConfig);
                await App.Config.update('appearance', appearanceConfig);
                
                // 変更があればAI履歴へイベントログを残す
                if (prefsConfig.username !== oldPrefsConfig.username) {
                    App.AI.logEvent(\`User changed their name to "\${prefsConfig.username}".\`, 'config_changed');
                }
                if (prefsConfig.agentName !== oldPrefsConfig.agentName) {
                    App.AI.logEvent(\`User changed the agent's name to "\${prefsConfig.agentName}".\`, 'config_changed');
                }
                if (prefsConfig.language !== oldPrefsConfig.language) {
                    App.AI.logEvent(\`User changed the system language to "\${prefsConfig.language}". Please communicate in this language from now on.\`, 'config_changed');
                }
                oldPrefsConfig = JSON.parse(JSON.stringify(prefsConfig));

                // 成功フィードバック
                status.textContent = "Saved";
                status.classList.remove('text-warning');
                status.classList.add('text-success');
                setTimeout(() => {
                    status.classList.add('opacity-0');
                    setTimeout(() => { status.classList.remove('text-success'); status.textContent = ""; }, 300);
                }, 2000);
            } catch (e) {
                status.textContent = "Error";
                status.classList.add('text-error');
            }
        }

        // --- Input Handlers ---
        const handleInput = (e) => {
            const keyPath = e.target.getAttribute('data-key');
            if (!keyPath) return;

            const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
            const parts = keyPath.split('.');
            const category = parts[0];
            
            let targetObj;
            if (category === 'preferences') targetObj = prefsConfig;
            else if (category === 'network') targetObj = networkConfig;
            else if (category === 'llm') targetObj = llmConfig;
            else if (category === 'appearance') targetObj = appearanceConfig;
            else return;

            if (parts.length === 2) {
                targetObj[parts[1]] = val;
            } else if (parts.length === 3) {
                if (!targetObj[parts[1]]) targetObj[parts[1]] = {};
                targetObj[parts[1]][parts[2]] = val;
            }
            
            clearTimeout(window._saveTimer);
            window._saveTimer = setTimeout(saveConfig, 500);
        };

        [
            'config-username', 'config-agentName', 'config-language', 
            'config-network-proxyUrl', 'config-network-allowCredentialsWithProxy',
            'config-app-uifont', 'config-app-monofont', 'config-app-fontsize', 'config-app-animations'
        ].forEach(id => {
            const el = DOM(id);
            if (el) el.addEventListener('input', handleInput);
        });


        // --- LLM Profile UI ---
        async function loadLlmProfiles(savedModelString) {
            try {
                // OS (Host) からマージ済みのプロバイダ一覧を取得する
                const providers = await MetaOS.system.getProviders();
                llmProfiles = { providers };
            } catch (e) {
                console.warn("Failed to get providers via MetaOS", e);
            }

            // フォールバック（取得失敗時）
            if (!llmProfiles.providers || llmProfiles.providers.length === 0) {
                 llmProfiles = {
                    providers: [
                        { id: "google", name: "Google (Gemini)", models: [{id: "gemini-3-flash-preview", name: "Gemini 3 Flash"}], defaultCapabilities: { maxMediaSizeMB: 100, supportedMimes: [] } },
                        { id: "openai", name: "OpenAI", models: [{id: "gpt-4o", name: "GPT-4o"}], defaultCapabilities: { maxMediaSizeMB: 20, supportedMimes: [] } },
                        { id: "anthropic", name: "Anthropic", models: [{id: "claude-3-5-sonnet-20241022", name: "Claude 3.5 Sonnet"}], defaultCapabilities: { maxMediaSizeMB: 5, supportedMimes: [] } }
                    ]
                 };
            }

            // 現在の設定値からプロバイダとモデルを分離 (e.g. "openai/gpt-4o")
            let initialModel = savedModelString;
            let initialProvider = "google";

            const slashIdx = savedModelString.indexOf('/');
            if (slashIdx !== -1) {
                initialProvider = savedModelString.substring(0, slashIdx).toLowerCase();
                initialModel = savedModelString.substring(slashIdx + 1);
            }
            currentProviderId = initialProvider;

            // プロバイダのセレクトボックスを構築
            const providerSelect = DOM('ui-provider-select');
            providerSelect.innerHTML = '';
            llmProfiles.providers.forEach(p => {
                const opt = document.createElement('option');
                opt.value = p.id;
                opt.textContent = p.name;
                if (p.id === initialProvider) opt.selected = true;
                providerSelect.appendChild(opt);
            });

            // プロバイダ変更時のイベント
            providerSelect.addEventListener('change', (e) => {
                currentProviderId = e.target.value;
                updateModelDatalist();
                // 新しいプロバイダの最初のモデルを自動選択
                const pData = llmProfiles.providers.find(p => p.id === currentProviderId);
                if (pData && pData.models && pData.models.length > 0) {
                    DOM('ui-model-input').value = pData.models[0].id;
                } else {
                    DOM('ui-model-input').value = "";
                }
                saveLlmConfig();
            });

            // モデル入力のイベント
            const modelInput = DOM('ui-model-input');
            modelInput.value = initialModel;
            modelInput.addEventListener('input', () => {
                updateCapabilityPanel();
                saveLlmConfig();
            });

            updateModelDatalist();
        }

        function updateModelDatalist() {
            const datalist = DOM('model-list');
            datalist.innerHTML = '';
            const providerData = llmProfiles.providers.find(p => p.id === currentProviderId);
            
            if (providerData && providerData.models) {
                providerData.models.forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = m.id;
                    opt.textContent = m.name;
                    datalist.appendChild(opt);
                });
            }
            updateCapabilityPanel();
        }

        function updateCapabilityPanel() {
            const panel = DOM('llm-capabilities-panel');
            const modelId = DOM('ui-model-input').value.trim();
            const providerData = llmProfiles.providers.find(p => p.id === currentProviderId);
            
            if (!providerData || !modelId) {
                panel.classList.add('hidden');
                return;
            }

            const modelData = (providerData.models || []).find(m => m.id === modelId);
            panel.classList.remove('hidden');

            // Header (Tokens)
            DOM('cap-model-name').textContent = modelData ? modelData.name : modelId;
            DOM('cap-context').textContent = modelData?.contextTokens 
                ? (modelData.contextTokens / 1000) + "K Tokens" 
                : "Custom Limits";

            // Capabilities Badges (Merge with provider default)
            const caps = { ...(providerData.defaultCapabilities || {}), ...(modelData?.capabilities || {}) };
            const badgesEl = DOM('cap-badges');
            badgesEl.innerHTML = '';

            const createBadge = (icon, text, colorClass) => {
                return \`<span class="px-2 py-0.5 rounded text-[9px] font-bold uppercase tracking-widest border flex items-center gap-1 \${colorClass}">\${icon} \${text}</span>\`;
            };

            const mimes = caps.supportedMimes || [];
            if (mimes.some(m => m.includes('image/'))) badgesEl.innerHTML += createBadge('🖼️', 'Vision', 'bg-primary/10 text-primary border-primary/30');
            if (mimes.some(m => m.includes('video/'))) badgesEl.innerHTML += createBadge('🎞️', 'Video', 'bg-primary/10 text-primary border-primary/30');
            if (mimes.some(m => m.includes('audio/'))) badgesEl.innerHTML += createBadge('🎙️', 'Audio', 'bg-primary/10 text-primary border-primary/30');
            if (mimes.some(m => m.includes('pdf'))) badgesEl.innerHTML += createBadge('📄', 'PDF', 'bg-success/10 text-success border-success/30');
            
            if (caps.maxMediaSizeMB > 0) {
                badgesEl.innerHTML += createBadge('📦', \`Max \${caps.maxMediaSizeMB}MB\`, 'bg-card text-text-muted border-border-main');
            } else if (modelData) {
                // 明示的にゼロの場合は非対応
                badgesEl.innerHTML += createBadge('⚠️', 'Text Only', 'bg-warning/10 text-warning border-warning/30');
            }

            // Pricing Area
            const pricingEl = DOM('cap-pricing');
            pricingEl.innerHTML = '';
            if (modelData && modelData.pricing) {
                if (modelData.pricing.tiers) {
                    // 階層型価格 (e.g. Gemini Pro)
                    pricingEl.innerHTML = \`<span class="text-success">Input: $\${modelData.pricing.tiers[0].input.toFixed(2)}+</span><span class="text-warning">Output: $\${modelData.pricing.tiers[0].output.toFixed(2)}+</span><span class="opacity-50">(per 1M tokens)</span>\`;
                } else {
                    // フラット価格
                    pricingEl.innerHTML = \`<span class="text-success">Input: $\${modelData.pricing.input.toFixed(2)}</span><span class="text-warning">Output: $\${modelData.pricing.output.toFixed(2)}</span><span class="opacity-50">(per 1M tokens)</span>\`;
                }
            } else {
                pricingEl.innerHTML = '<span class="opacity-50">Pricing data not available</span>';
            }
        }

        function saveLlmConfig() {
            const provider = currentProviderId;
            const model = DOM('ui-model-input').value.trim();
            if (!model) return;

            // Googleの場合はプレフィックスを省略する（後方互換）
            const finalModelString = provider === 'google' ? model : \`\${provider}/\${model}\`;
            
            llmConfig.model = finalModelString;
            
            clearTimeout(window._saveTimer);
            window._saveTimer = setTimeout(saveConfig, 500);
        }

        // --- Themes ---
        async function loadThemes() {
            const container = DOM('theme-list');
            container.innerHTML = '';

            try {
                // V2 API
                const files = await MetaOS.fs.list('system/themes');
                const themeFiles = files.filter(f => f.endsWith('.json')).sort();

                for (const path of themeFiles) {
                    try {
                        const themeData = JSON.parse(await MetaOS.fs.read(path));
                        const meta = themeData.meta || { name: path.split('/').pop().replace('.json', ''), author: 'System' };
                        const isActive = appearanceConfig.theme === path;
                        
                        const bg = themeData.colors?.bg?.app || '#1a1b26';
                        const fg = themeData.colors?.text?.main || '#c0caf5';
                        const accent = themeData.colors?.accent?.primary || '#7aa2f7';

                        const div = document.createElement('div');
                        div.className = \`cursor-pointer p-4 rounded-xl border-2 transition-all relative overflow-hidden group shadow-sm hover:shadow-md \${isActive ? 'border-primary bg-primary/5 ring-4 ring-primary/10' : 'border-border-main hover:border-text-muted bg-card'}\`;
                        div.onclick = () => {
                            if (appearanceConfig.theme !== path) {
                                appearanceConfig.theme = path;
                                saveConfig().then(loadThemes);
                            }
                        };

                        div.innerHTML = \`
                            <div class="flex items-center gap-3 relative z-10">
                                <div class="w-12 h-12 rounded-full border border-gray-600 shadow-inner shrink-0 flex items-center justify-center transition-transform group-hover:scale-105" style="background:\${bg}">
                                    <div class="w-5 h-5 rounded-full shadow-[0_0_10px_rgba(0,0,0,0.5)]" style="background:\${accent}"></div>
                                </div>
                                <div class="min-w-0 flex-1">
                                    <div class="font-bold text-sm truncate flex items-center justify-between" style="color:\${isActive ? 'rgb(var(--c-accent-primary))' : 'inherit'}">
                                        \${meta.name}
                                        \${isActive ? '<svg class="w-4 h-4 text-primary shrink-0 ml-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path></svg>' : ''}
                                    </div>
                                    <div class="text-[10px] text-text-muted truncate mt-0.5 font-mono opacity-80 uppercase tracking-widest">by \${meta.author}</div>
                                </div>
                            </div>
                        \`;
                        container.appendChild(div);

                    } catch(err) { console.warn("Invalid theme file", path); }
                }
            } catch(e) { container.innerHTML = \`<div class="text-error text-sm">Failed to load themes.</div>\`; }
        }

        // Boot
        document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
    </script>
</body>
</html>`.trim(),

  "system/config/appearance.json": JSON.stringify({
  "theme": "system/themes/light.json",
  "typography": {
    "uiFont": "Inter",
    "monoFont": "monospace",
    "fontSize": "medium"
  },
  "layout": {
    "animations": true
  }
}, null, 2),

  "system/config/llm.json": JSON.stringify({
  "model": "gemini-3-flash-preview",
  "temperature": 1
}, null, 2),

  "system/config/network.json": JSON.stringify({
  "proxyUrl": "https://corsproxy.io/?",
  "allowCredentialsWithProxy": false
}, null, 2),

  "system/config/preferences.json": JSON.stringify({
  "username": "User",
  "agentName": "Itera",
  "language": "English",
  "autoUpdateSystemFiles": true
}, null, 2),

  "system/lib/std.js": `
/**
 * Itera OS v2 Guest Standard Library (std.js)
 * Clean, generic VFS and OS utilities for Guest Applications.
 */

(function (global) {
    if (!global.MetaOS) {
        console.warn("[Std] MetaOS bridge not found. The app is likely running outside of Itera OS.");
    }

    // ==========================================
    // File System Utilities
    // ==========================================
    const FS = {
        /**
         * Parses and returns a JSON file from the VFS safely.
         */
        async readJson(path, defaultValue = null) {
            try {
                const content = await global.MetaOS.fs.read(path);
                return JSON.parse(content);
            } catch (e) {
                return defaultValue;
            }
        },

        /**
         * Stringifies and writes data as a JSON file.
         */
        async writeJson(path, data, options = { overwrite: true, silent: true }) {
            const content = JSON.stringify(data, null, 2);
            await global.MetaOS.fs.write(path, content, options);
        },

        /**
         * Reads a file as binary (Uint8Array).
         */
        async readBinary(path) {
            return await global.MetaOS.fs.read(path, { encoding: 'binary' });
        },

        /**
         * Writes a binary (Uint8Array) file.
         */
        async writeBinary(path, uint8ArrayData, options = { overwrite: true, silent: true }) {
            await global.MetaOS.fs.write(path, uint8ArrayData, options);
        }
    };

    // ==========================================
    // Context & Runtime
    // ==========================================
    const Context = {
        /**
         * Retrieves the arguments passed when this app was launched (spawned).
         * Combines URI query parameters and programmatic arguments.
         */
        async getArgs() {
            try {
                if (window.__ITERA_ARGS__) return window.__ITERA_ARGS__;
                return await global.MetaOS.system.getArgs() || {};
            } catch (e) {
                return window.__ITERA_ARGS__ || {};
            }
        }
    };

    // ==========================================
    // Application KV Storage
    // ==========================================
    const Storage = {
        _getPath(key) {
            const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
            return \`data/apps/\${safeKey}.json\`;
        },
        async get(key, defaultValue = {}) {
            return await FS.readJson(this._getPath(key), defaultValue);
        },
        async set(key, value) {
            await FS.writeJson(this._getPath(key), value);
        }
    };

    // ==========================================
    // System Configuration Access
    // ==========================================
    const Config = {
        async get(category = 'preferences') {
            return await FS.readJson(\`system/config/\${category}.json\`, {});
        },
        async update(category, updates) {
            const current = await this.get(category);
            const merged = { ...current, ...updates };
            const path = \`system/config/\${category}.json\`;
            // 'system: true' option is required to overwrite files in the system/ domain
            await global.MetaOS.fs.write(path, JSON.stringify(merged, null, 2), { 
                overwrite: true, 
                system: true, 
                silent: true 
            });
            return merged;
        }
    };

    // ==========================================
    // AI Cognitive Copilot
    // ==========================================
    const AI = {
        async logEvent(message, type = 'app_event', triggerLlm = false) {
            if (global.MetaOS?.ai?.log) {
                await global.MetaOS.ai.log(message, type, { trigger_llm: triggerLlm });
            }
        }
    };

    global.App = { FS, Context, Storage, Config, AI };

})(window);`.trim(),

  "system/lib/ui.js": `
/**
 * Itera Guest UI Kit (ui.js) v2
 * Provides theme configuration, shared UI utilities, and OS-native dialogs.
 */

(function(global) {
    if (global.tailwind) {
        global.tailwind.config = {
            darkMode: 'class',
            theme: {
                extend: {
                    fontFamily: {
                        sans: ['var(--font-sans)', 'system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'Arial', '"Noto Sans JP"', '"Noto Sans"', '"Hiragino Kaku Gothic ProN"', '"Hiragino Sans"', 'Meiryo', 'sans-serif', '"Apple Color Emoji"', '"Segoe UI Emoji"', '"Segoe UI Symbol"', '"Noto Color Emoji"'],
                        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', '"Liberation Mono"', '"Courier New"', 'monospace']
                    },
                    colors: {
                        app: 'rgb(var(--c-bg-app) / <alpha-value>)',
                        panel: 'rgb(var(--c-bg-panel) / <alpha-value>)',
                        card: 'rgb(var(--c-bg-card) / <alpha-value>)',
                        hover: 'rgb(var(--c-bg-hover) / <alpha-value>)',
                        overlay: 'rgb(var(--c-bg-overlay) / <alpha-value>)',
                        border: {
                            main: 'rgb(var(--c-border-main) / <alpha-value>)',
                            highlight: 'rgb(var(--c-border-highlight) / <alpha-value>)',
                        },
                        text: {
                            main: 'rgb(var(--c-text-main) / <alpha-value>)',
                            muted: 'rgb(var(--c-text-muted) / <alpha-value>)',
                            inverted: 'rgb(var(--c-text-inverted) / <alpha-value>)',
                            system: 'rgb(var(--c-text-system) / <alpha-value>)',
                        },
                        primary: 'rgb(var(--c-accent-primary) / <alpha-value>)',
                        success: 'rgb(var(--c-accent-success) / <alpha-value>)',
                        warning: 'rgb(var(--c-accent-warning) / <alpha-value>)',
                        error: 'rgb(var(--c-accent-error) / <alpha-value>)',
                    }
                }
            }
        };
    }

    const style = document.createElement('style');
    style.textContent = \`
        body { 
            -webkit-font-smoothing: antialiased;
            -moz-osx-font-smoothing: grayscale;
        }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgb(var(--c-bg-hover)); border-radius: 3px; }
        ::-webkit-scrollbar-thumb:hover { background: rgb(var(--c-text-muted)); }
        
        @keyframes iteraFadeIn { from { opacity: 0; } to { opacity: 1; } }
        @keyframes iteraSlideUp { from { opacity: 0; transform: translateY(10px) scale(0.98); } to { opacity: 1; transform: translateY(0) scale(1); } }
        @keyframes iteraSpin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        
        .itera-animate-fade { animation: iteraFadeIn 0.2s ease-out forwards; }
        .itera-animate-modal { animation: iteraSlideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
        .itera-loader { border: 3px solid rgb(var(--c-bg-hover)); border-top: 3px solid rgb(var(--c-accent-primary)); border-radius: 50%; width: 24px; height: 24px; animation: iteraSpin 1s linear infinite; }
    \`;
    document.head.appendChild(style);

    global.AppUI = {
        go: (path) => {
            if (global.MetaOS) global.MetaOS.system.spawn(path, { pid: 'main' });
            else window.location.href = path;
        },
        home: () => {
            if (global.MetaOS) global.MetaOS.system.spawn('index.html', { pid: 'main' });
        },
        notify: (message, type = 'info', duration = 3000) => {
            let container = document.getElementById('__itera-toast-container');
            if (!container) {
                container = document.createElement('div');
                container.id = '__itera-toast-container';
                Object.assign(container.style, {
                    position: 'fixed', bottom: '1.25rem', right: '1.25rem', display: 'flex',
                    flexDirection: 'column', gap: '0.5rem', zIndex: '9999', pointerEvents: 'none'
                });
                document.body.appendChild(container);
            }

            const TYPES = {
                info:    { icon: 'ℹ️', color: 'rgb(var(--c-accent-primary))' },
                success: { icon: '✅', color: 'rgb(var(--c-accent-success))' },
                warning: { icon: '⚠️', color: 'rgb(var(--c-accent-warning))' },
                error:   { icon: '❌', color: 'rgb(var(--c-accent-error))' }
            };
            const { icon, color } = TYPES[type] || TYPES.info;

            const toast = document.createElement('div');
            toast.className = "itera-animate-fade";
            Object.assign(toast.style, {
                display: 'flex', alignItems: 'center', gap: '0.75rem', padding: '0.75rem 1rem',
                borderRadius: '0.5rem', background: 'rgb(var(--c-bg-panel))', color: 'rgb(var(--c-text-main))',
                border: \`1px solid \${color}\`, boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                fontSize: '0.875rem', pointerEvents: 'auto', maxWidth: '320px', wordBreak: 'break-word',
                transition: 'opacity 0.3s ease'
            });

            toast.innerHTML = \`<div style="width:4px; height:100%; min-height:1.5rem; background:\${color}; border-radius:2px; flex-shrink:0;"></div><span>\${icon}</span><span>\${message}</span>\`;
            container.appendChild(toast);

            setTimeout(() => {
                toast.style.opacity = '0';
                toast.addEventListener('transitionend', () => toast.remove());
            }, duration);
        },
        alert: (message, title = "System Alert") => {
            return AppUI._createDialog({ type: 'alert', message, title });
        },
        confirm: (message, title = "Confirmation") => {
            return AppUI._createDialog({ type: 'confirm', message, title });
        },
        prompt: (message, defaultValue = "", title = "Input Required") => {
            return AppUI._createDialog({ type: 'prompt', message, title, defaultValue });
        },
        showLoading: (message = "Processing...") => {
            AppUI.hideLoading();
            const overlay = document.createElement('div');
            overlay.id = '__itera-loading-overlay';
            overlay.className = "fixed inset-0 bg-app/80 backdrop-blur-sm z-[9999] flex flex-col items-center justify-center itera-animate-fade";
            overlay.innerHTML = \`
                <div class="itera-loader mb-4"></div>
                <div class="text-sm font-bold text-text-muted tracking-wider uppercase animate-pulse">\${message}</div>
            \`;
            document.body.appendChild(overlay);
        },
        hideLoading: () => {
            const overlay = document.getElementById('__itera-loading-overlay');
            if (overlay) overlay.remove();
        },
        getThemeColor: (tokenName) => {
            const root = document.documentElement;
            let val = getComputedStyle(root).getPropertyValue(\`--c-\${tokenName}\`).trim();
            if (!val) return '#888888';
            return val.includes(' ') ? \`rgb(\${val.split(' ').join(', ')})\` : val;
        },
        _createDialog: ({ type, message, title, defaultValue }) => {
            return new Promise((resolve) => {
                const overlay = document.createElement('div');
                overlay.className = "fixed inset-0 bg-black/60 backdrop-blur-sm z-[9998] flex items-center justify-center p-4 itera-animate-fade select-none";
                
                const box = document.createElement('div');
                box.className = "bg-panel border border-border-main rounded-2xl shadow-2xl w-full max-w-sm flex flex-col overflow-hidden itera-animate-modal";
                
                const header = document.createElement('div');
                header.className = "px-5 py-3 border-b border-border-main bg-card/50 flex items-center gap-2";
                header.innerHTML = \`<span class="text-primary">✦</span><span class="font-bold text-sm text-text-main">\${title}</span>\`;
                
                const body = document.createElement('div');
                body.className = "p-5 text-sm text-text-main whitespace-pre-wrap leading-relaxed";
                body.textContent = message;

                let input = null;
                if (type === 'prompt') {
                    input = document.createElement('input');
                    input.type = 'text';
                    input.value = defaultValue || '';
                    input.className = "w-full mt-4 bg-app border border-border-main rounded-lg p-2.5 text-text-main focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary transition shadow-inner";
                    body.appendChild(input);
                }

                const footer = document.createElement('div');
                footer.className = "px-5 py-3 border-t border-border-main bg-card flex justify-end gap-2";

                const closeDialog = (val) => {
                    overlay.style.opacity = '0';
                    setTimeout(() => overlay.remove(), 200);
                    resolve(val);
                };

                const btnCancel = document.createElement('button');
                btnCancel.className = "px-4 py-2 rounded-lg text-xs font-bold text-text-muted hover:text-text-main hover:bg-hover transition";
                btnCancel.textContent = "Cancel";
                btnCancel.onclick = () => closeDialog(type === 'prompt' ? null : false);

                const btnOk = document.createElement('button');
                btnOk.className = "px-4 py-2 rounded-lg text-xs font-bold bg-primary text-white hover:bg-primary/90 shadow transition";
                btnOk.textContent = "OK";
                btnOk.onclick = () => closeDialog(type === 'prompt' ? input.value : true);

                if (type !== 'alert') footer.appendChild(btnCancel);
                footer.appendChild(btnOk);

                box.append(header, body, footer);
                overlay.appendChild(box);
                document.body.appendChild(overlay);

                if (input) {
                    setTimeout(() => { input.focus(); input.select(); }, 50);
                    input.addEventListener('keydown', (e) => {
                        if (e.key === 'Enter') btnOk.click();
                        if (e.key === 'Escape') btnCancel.click();
                    });
                } else {
                    setTimeout(() => btnOk.focus(), 50);
                    overlay.addEventListener('keydown', (e) => {
                        if (e.key === 'Escape') type === 'alert' ? btnOk.click() : btnCancel.click();
                    });
                }
            });
        }
    };
})(window);`.trim(),

  "system/registry/apps.json": JSON.stringify([
  {
    "id": "notes",
    "name": "Notes",
    "icon": "📝",
    "path": "apps/notes.html",
    "description": "Markdown text editor",
    "fileHandlers": [
      {
        "action": "view",
        "extensions": [
          "md",
          "txt"
        ],
        "mimeTypes": [
          "text/markdown",
          "text/plain"
        ]
      }
    ]
  },
  {
    "id": "settings",
    "name": "Settings",
    "icon": "⚙️",
    "path": "system/apps/settings.html",
    "description": "System configuration"
  }
], null, 2),

  "system/registry/associations.json": JSON.stringify({
  "extensions": {
    "md": "notes",
    "txt": "notes"
  },
  "mimeTypes": {
    "text/markdown": "notes",
    "text/plain": "notes"
  }
}, null, 2),

  "system/registry/llm_profiles.json": JSON.stringify({
  "providers": [
    {
      "id": "google",
      "name": "Google (Gemini)",
      "placeholder": "AIzaSy...",
      "requiresUrl": false,
      "defaultCapabilities": {
        "maxMediaSizeMB": 100,
        "supportedMimes": [
          "application/pdf",
          "image/*",
          "video/*",
          "audio/*"
        ]
      },
      "models": [
        {
          "id": "gemini-3.5-flash",
          "name": "Gemini 3.5 Flash",
          "contextTokens": 1048576,
          "pricing": {
            "input": 1.5,
            "output": 9
          },
          "capabilities": {
            "maxMediaSizeMB": 100,
            "supportedMimes": [
              "application/pdf",
              "image/*",
              "video/*",
              "audio/*"
            ]
          }
        },
        {
          "id": "gemini-3.1-pro-preview",
          "name": "Gemini 3.1 Pro",
          "contextTokens": 1048576,
          "pricing": {
            "tiers": [
              {
                "maxTokens": 200000,
                "input": 2,
                "output": 12
              },
              {
                "maxTokens": null,
                "input": 4,
                "output": 18
              }
            ]
          },
          "capabilities": {
            "maxMediaSizeMB": 100,
            "supportedMimes": [
              "application/pdf",
              "image/*",
              "video/*",
              "audio/*"
            ]
          }
        },
        {
          "id": "gemini-3.1-flash-lite",
          "name": "Gemini 3.1 Flash Lite",
          "contextTokens": 1048576,
          "pricing": {
            "input": 0.25,
            "output": 1.5
          }
        },
        {
          "id": "gemini-3-flash-preview",
          "name": "Gemini 3 Flash",
          "contextTokens": 1048576,
          "pricing": {
            "input": 0.5,
            "output": 3
          }
        }
      ]
    },
    {
      "id": "openai",
      "name": "OpenAI",
      "placeholder": "sk-proj-...",
      "requiresUrl": false,
      "defaultCapabilities": {
        "maxMediaSizeMB": 50,
        "supportedMimes": [
          "image/*",
          "application/pdf",
          "application/vnd.openxmlformats-officedocument.*",
          "text/*",
          "application/json"
        ]
      },
      "models": [
        {
          "id": "gpt-5.5",
          "name": "GPT-5.5",
          "contextTokens": 1050000,
          "pricing": {
            "input": 5,
            "output": 30
          }
        },
        {
          "id": "gpt-5.5-pro",
          "name": "GPT-5.5 Pro",
          "contextTokens": 1050000,
          "pricing": {
            "input": 30,
            "output": 180
          }
        },
        {
          "id": "gpt-5.4",
          "name": "GPT-5.4",
          "contextTokens": 1050000,
          "pricing": {
            "input": 2.5,
            "output": 15
          }
        },
        {
          "id": "gpt-5.4-mini",
          "name": "GPT-5.4 Mini",
          "contextTokens": 400000,
          "pricing": {
            "input": 0.75,
            "output": 4.5
          }
        }
      ]
    },
    {
      "id": "anthropic",
      "name": "Anthropic",
      "placeholder": "sk-ant-...",
      "requiresUrl": false,
      "defaultCapabilities": {
        "maxMediaSizeMB": 500,
        "supportedMimes": [
          "image/*",
          "application/pdf",
          "text/plain"
        ]
      },
      "models": [
        {
          "id": "claude-fable-5",
          "name": "Claude Fable 5",
          "contextTokens": 1000000,
          "pricing": {
            "input": 10,
            "output": 50
          }
        },
        {
          "id": "claude-opus-4-8",
          "name": "Claude Opus 4.8",
          "contextTokens": 1000000,
          "pricing": {
            "input": 5,
            "output": 25
          }
        },
        {
          "id": "claude-sonnet-5",
          "name": "Claude Sonnet 5",
          "contextTokens": 1000000,
          "pricing": {
            "input": 3,
            "output": 15
          }
        },
        {
          "id": "claude-haiku-4-5",
          "name": "Claude Haiku 4.5",
          "contextTokens": 200000,
          "pricing": {
            "input": 1,
            "output": 5
          }
        }
      ]
    },
    {
      "id": "openrouter",
      "name": "OpenRouter",
      "placeholder": "sk-or-v1-...",
      "requiresUrl": false,
      "defaultCapabilities": {
        "maxMediaSizeMB": 20,
        "supportedMimes": [
          "image/*",
          "application/pdf",
          "text/*",
          "application/json"
        ]
      },
      "models": []
    },
    {
      "id": "custom",
      "name": "Local / Custom (OpenAI Compatible)",
      "placeholder": "API Key (Optional)",
      "urlPlaceholder": "http://localhost:11434/v1",
      "requiresUrl": true,
      "defaultCapabilities": {
        "maxMediaSizeMB": 20,
        "supportedMimes": [
          "image/*",
          "application/pdf",
          "text/*",
          "application/json"
        ]
      },
      "models": []
    }
  ]
}, null, 2),

  "system/registry/services.json": JSON.stringify([], null, 2),

  "system/themes/dark.json": JSON.stringify({
  "meta": {
    "name": "Itera Dark",
    "author": "System"
  },
  "colors": {
    "bg": {
      "app": "#0f172a",
      "panel": "#1e293b",
      "card": "#334155",
      "hover": "#475569",
      "overlay": "#000000"
    },
    "border": {
      "main": "#334155",
      "highlight": "#3b82f6"
    },
    "text": {
      "main": "#f1f5f9",
      "muted": "#94a3b8",
      "inverted": "#0f172a",
      "system": "#60a5fa",
      "tag_attr": "#94a3b8",
      "tag_content": "#cbd5e1"
    },
    "accent": {
      "primary": "#3b82f6",
      "success": "#10b981",
      "warning": "#f59e0b",
      "error": "#ef4444"
    },
    "tags": {
      "thinking": "#1e3a8a",
      "plan": "#064e3b",
      "report": "#312e81",
      "error": "#7f1d1d"
    }
  }
}, null, 2),

  "system/themes/light.json": JSON.stringify({
  "meta": {
    "name": "Itera Light",
    "author": "System"
  },
  "colors": {
    "bg": {
      "app": "#f9fafb",
      "panel": "#ffffff",
      "card": "#f3f4f6",
      "hover": "#e5e7eb",
      "overlay": "#000000"
    },
    "border": {
      "main": "#e5e7eb",
      "highlight": "#3b82f6"
    },
    "text": {
      "main": "#1f2937",
      "muted": "#6b7280",
      "inverted": "#ffffff",
      "system": "#2563eb",
      "tag_attr": "#6b7280",
      "tag_content": "#374151"
    },
    "accent": {
      "primary": "#2563eb",
      "success": "#059669",
      "warning": "#d97706",
      "error": "#dc2626"
    },
    "tags": {
      "thinking": "#1d4ed8",
      "plan": "#047857",
      "report": "#4338ca",
      "error": "#b91c1c"
    }
  }
}, null, 2),

  "system/themes/midnight.json": JSON.stringify({
  "meta": {
    "name": "Midnight Protocol",
    "author": "System"
  },
  "colors": {
    "bg": {
      "app": "#020617",
      "panel": "#0f172a",
      "card": "#1e293b",
      "hover": "#334155",
      "overlay": "#000000"
    },
    "border": {
      "main": "#1e293b",
      "highlight": "#6366f1"
    },
    "text": {
      "main": "#e2e8f0",
      "muted": "#64748b",
      "inverted": "#020617",
      "system": "#818cf8",
      "tag_attr": "#94a3b8",
      "tag_content": "#cbd5e1"
    },
    "accent": {
      "primary": "#6366f1",
      "success": "#10b981",
      "warning": "#f59e0b",
      "error": "#f43f5e"
    },
    "tags": {
      "thinking": "#312e81",
      "plan": "#064e3b",
      "report": "#4338ca",
      "error": "#881337"
    }
  }
}, null, 2)
};

export const BUILD_TIME = 1783952724554;
