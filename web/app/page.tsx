'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronsLeft, Download, FolderOpen, Library, Menu, Settings, X } from 'lucide-react';
import type {
  ArrangementSummary,
  JobConfig,
  ProgressUpdate,
  ProjectMeta,
  SelectableStem,
  SourceMeta,
  StemSet,
} from '@prismaxim/shared';
import StartPanel from '@/components/StartPanel';
import LibraryPanel from '@/components/LibraryPanel';
import OptionsPanel from '@/components/OptionsPanel';
import ProjectPanel from '@/components/ProjectPanel';
import ProgressPanel from '@/components/ProgressPanel';
import TabBar, { type TabMeta } from '@/components/TabBar';
import Editor from '@/components/editor/Editor';
import Mixer from '@/components/Mixer';
import { runJob, splitSavedSource } from '@/lib/pipeline';
import { store } from '@/lib/store';
import {
  cloneTracksForMerge,
  emptyProject,
  fromStemSet,
  uid,
  type EditorProject,
  type EditorTrack,
} from '@/lib/editor/model';
import type { ImportMode } from '@/components/StartPanel';
import { keepScreenAwake } from '@/lib/platform/wakeLock';
import { IS_MOBILE } from '@/lib/env';
import { DEFAULT_BACKEND_URL } from '@/lib/config';
import {
  estimateWorkspaceBytes,
  parseWorkspace,
  serializeWorkspace,
  workspaceFilename,
  type WorkspaceTab,
} from '@/lib/workspace';
import {
  canWriteInPlace,
  openProjectFile,
  pickSaveTarget,
  writeProjectFile,
  type ProjectFile,
} from '@/lib/platform/projectFile';

type View = 'import' | 'library' | 'project' | 'options';
const TITLES: Record<View, string> = {
  import: 'Import',
  library: 'Library',
  project: 'Project',
  options: 'Options',
};

interface Loaded {
  title: string;
  /** The raw 6-stem set, present for fresh splits and saved projects (drives the
   *  mobile quick-mixer). Absent for arrangements, which need the full editor. */
  set?: StemSet;
  /** Prebuilt editor project — present for arrangements (which carry no stem set).
   *  For set-based loads the project is derived from `set`: eagerly on desktop,
   *  lazily on mobile (see buildProject / toggleMobileEdit) so the quick-mixer
   *  path doesn't hold a second full copy of the audio in memory. */
  project?: EditorProject;
}

/** The audio behind one open song. Held outside React state — see `contentRef`. */
interface TabContent {
  project: EditorProject;
  set?: StemSet;
}

/** Turn a load result into the editor project a tab starts from. */
function buildProject(loaded: Loaded): EditorProject {
  if (loaded.project) {
    // Arrangement: comes with a prebuilt project (no stem set).
    if (!IS_MOBILE) return loaded.project;
    // Mobile has no MIDI features — drop any MIDI tracks so a loaded project
    // never opens them (audio tracks only).
    const audioOnly = loaded.project.tracks.filter((t) => !t.midi);
    return audioOnly.length === loaded.project.tracks.length
      ? loaded.project
      : { ...loaded.project, tracks: audioOnly };
  }
  // Desktop / web: no quick-mixer, so build the editor project up front.
  if (loaded.set && !IS_MOBILE) return fromStemSet(loaded.set);
  // Mobile split/project: defer building the per-stem AudioBuffers until the
  // user opens the editor (toggleMobileEdit) — the mixer runs off the stem set,
  // so building them now would hold a second full copy of the audio.
  return emptyProject();
}

/** Next free "Untitled" name, so several blank tabs stay tellable apart. */
function untitledName(tabs: TabMeta[]): string {
  const taken = new Set(tabs.map((t) => t.title));
  if (!taken.has('Untitled')) return 'Untitled';
  for (let n = 2; ; n++) if (!taken.has(`Untitled ${n}`)) return `Untitled ${n}`;
}

/** A tab's tracks, materialising the mobile-lazy case on demand. */
function tracksOf(content: TabContent): EditorTrack[] {
  if (content.project.tracks.length) return content.project.tracks;
  return content.set ? fromStemSet(content.set).tracks : [];
}

export default function Home() {
  const [modal, setModal] = useState<View | null>('import');

  /* ---------- open songs (tabs) ----------
   * Tab *metadata* is state (the bar redraws on title/dirty changes); the
   * projects themselves live in a ref, because the mounted editor mirrors its
   * project up on every edit and re-rendering the shell that often would churn
   * the whole tree — and would hand the editor a new `initialProject`, which
   * rebuilds its audio engine. Only one editor is mounted at a time: `project`
   * below is the seed for the active tab, set on load and on tab switch only. */
  const [tabs, setTabs] = useState<TabMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const contentRef = useRef(new Map<string, TabContent>());

  const [project, setProject] = useState<EditorProject>(() => emptyProject());
  // Mobile lands in a simple faders mixer after a split; the full DAW editor is
  // opt-in via a toggle. `stemSet` holds the raw split for the mixer (null once an
  // arrangement — which the mixer can't represent — is loaded).
  const [stemSet, setStemSet] = useState<StemSet | null>(null);
  const [mobileEdit, setMobileEdit] = useState(false);
  const [sessionId, setSessionId] = useState(0);
  // Tracks queued to append to the live editor project (an "Add to open project"
  // import, or another open song merged in). Bumping `token` re-triggers the
  // editor's append effect each time.
  const [pendingImport, setPendingImport] = useState<{ tracks: EditorTrack[]; token: number } | null>(
    null,
  );
  const importTokenRef = useRef(0);
  const [backendUrl, setBackendUrl] = useState(DEFAULT_BACKEND_URL);
  const [reloadKey, setReloadKey] = useState(0);
  const [job, setJob] = useState<{ running: boolean; progress?: ProgressUpdate; error?: string }>({
    running: false,
  });
  const cancelledRef = useRef(false);
  /* ---------- the project file this session is bound to ----------
   * Everything open in the app can be written to one file on disk and read back
   * (see lib/workspace.ts). `workspaceDirty` tracks edits made since that write,
   * which is a different question from a tab's own dot (unsaved to the library). */
  const [projectFile, setProjectFile] = useState<ProjectFile | null>(null);
  const [projectSavedAt, setProjectSavedAt] = useState<string | null>(null);
  const [projectDirty, setProjectDirty] = useState(false);
  // Start closed so the static-export first paint doesn't flash an open drawer on
  // mobile; the mount effect opens it on desktop (or restores the saved rail).
  const [navOpen, setNavOpen] = useState(false);

  const title = useMemo(
    () => tabs.find((t) => t.id === activeId)?.title ?? 'Untitled',
    [tabs, activeId],
  );

  useEffect(() => {
    // On phones the sidebar is an off-canvas drawer (see globals.css) — start it
    // closed so the editor is full-screen. On desktop, restore the saved rail
    // preference.
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches) {
      setNavOpen(false);
      return;
    }
    try {
      const v = localStorage.getItem('prismaxim-nav-open');
      // Desktop defaults to open (rail expanded) on first visit.
      setNavOpen(v === null ? true : v === '1');
    } catch {
      setNavOpen(true);
    }
  }, []);

  // Open a view's modal; on mobile also close the drawer so it doesn't cover it.
  const selectView = (v: View) => {
    setModal(v);
    if (typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches) {
      setNavOpen(false);
    }
  };

  const toggleNav = () =>
    setNavOpen((o) => {
      const n = !o;
      try {
        localStorage.setItem('prismaxim-nav-open', n ? '1' : '0');
      } catch {
        /* ignore */
      }
      return n;
    });

  const onProgress = useCallback((progress: ProgressUpdate) => {
    if (!cancelledRef.current) setJob({ running: true, progress });
  }, []);

  /* ---------- tab plumbing ---------- */

  // Both callbacks below are referentially stable and never set state to an
  // unchanged value: the editor fires them on every edit, and a render here
  // would hand it a fresh `initialProject` and rebuild its audio engine.
  const mirrorProject = useCallback((p: EditorProject) => {
    const id = activeIdRef.current;
    const content = id ? contentRef.current.get(id) : undefined;
    if (content) content.project = p;
  }, []);

  const markDirty = useCallback((dirty: boolean) => {
    const id = activeIdRef.current;
    if (!id) return;
    // Any edit also means the project file on disk is behind. Setting an
    // already-true flag is a no-op in React, so this stays free after the first.
    if (dirty) setProjectDirty(true);
    setTabs((prev) => {
      const i = prev.findIndex((t) => t.id === id);
      if (i < 0 || prev[i]!.dirty === dirty) return prev; // same ref → no re-render
      const next = prev.slice();
      next[i] = { ...next[i]!, dirty };
      return next;
    });
  }, []);

  /** Show a tab: reseed the editor from its stored project and remount it. */
  const showTab = useCallback((id: string) => {
    const content = contentRef.current.get(id);
    if (!content) return;
    activeIdRef.current = id;
    setActiveId(id);
    setProject(content.project);
    setStemSet(content.set ?? null);
    setMobileEdit(false); // default to the mixer view on mobile
    setSessionId((s) => s + 1);
    setJob({ running: false });
    setModal(null);
  }, []);

  /** Open a load result in its own tab, alongside whatever is already open. */
  const openInTab = useCallback(
    (loaded: Loaded) => {
      const id = uid();
      contentRef.current.set(id, { project: buildProject(loaded), set: loaded.set });
      setTabs((prev) => [...prev, { id, title: loaded.title, dirty: false }]);
      setProjectDirty(true);
      showTab(id);
      setReloadKey((k) => k + 1);
    },
    [showTab],
  );

  /**
   * Open a blank tab. Somewhere to build a project from scratch — and the tab to
   * paste parts of several songs into when none of them should be the host.
   */
  const openEmptyTab = useCallback(() => {
    const id = uid();
    contentRef.current.set(id, { project: emptyProject() });
    setTabs((prev) => [...prev, { id, title: untitledName(prev), dirty: false }]);
    setProjectDirty(true);
    showTab(id);
  }, [showTab]);

  const closeTab = useCallback(
    (id: string) => {
      const meta = tabs.find((t) => t.id === id);
      if (!meta) return;
      if (meta.dirty && !window.confirm(`Close "${meta.title}"? Unsaved changes will be lost.`)) {
        return;
      }
      const index = tabs.findIndex((t) => t.id === id);
      const rest = tabs.filter((t) => t.id !== id);
      contentRef.current.delete(id);
      setTabs(rest);
      setProjectDirty(true);
      if (id !== activeId) return; // the mounted editor is untouched
      // Fall through to whichever tab slid into this slot, else the one before it.
      const next = rest[index] ?? rest[index - 1];
      if (next) {
        showTab(next.id);
        return;
      }
      activeIdRef.current = null;
      setActiveId(null);
      setProject(emptyProject());
      setStemSet(null);
      setSessionId((s) => s + 1);
      setModal('import');
    },
    [tabs, activeId, showTab],
  );

  /**
   * Fold another open song into the active project — the "one project, several
   * songs" case. Goes through the editor's import channel when there's a live
   * project, so the merge lands on the undo stack; otherwise (the mobile
   * quick-mixer, whose editor project is still lazy) it reseeds the editor with
   * the combined project instead.
   */
  const mergeTab = useCallback(
    (sourceId: string) => {
      const destId = activeIdRef.current;
      const dest = destId ? contentRef.current.get(destId) : undefined;
      const source = contentRef.current.get(sourceId);
      if (!dest || !source || sourceId === destId) return;
      const label = tabs.find((t) => t.id === sourceId)?.title;
      const tracks = cloneTracksForMerge(tracksOf(source), label);
      if (!tracks.length) return;

      if (dest.project.tracks.length) {
        importTokenRef.current += 1;
        setPendingImport({ tracks, token: importTokenRef.current });
      } else {
        const base = dest.set ? fromStemSet(dest.set) : dest.project;
        const merged = { ...base, tracks: [...base.tracks, ...tracks] };
        dest.project = merged;
        setProject(merged);
        setSessionId((s) => s + 1);
      }
      setProjectDirty(true);
      setMobileEdit(true); // the quick mixer can't show a multi-song project
      setModal(null);
    },
    [tabs],
  );

  // Mobile: switch between the quick faders mixer and the full editor. The editor
  // project is built lazily on first entry (see buildProject) to keep the mixer
  // path light on memory.
  const toggleMobileEdit = useCallback(() => {
    const entering = !mobileEdit;
    if (entering && stemSet && project.tracks.length === 0) {
      const built = fromStemSet(stemSet);
      const id = activeIdRef.current;
      const content = id ? contentRef.current.get(id) : undefined;
      if (content) content.project = built;
      setProject(built);
    }
    setMobileEdit(entering);
  }, [mobileEdit, stemSet, project]);

  // Append a load result to the live editor project (an "Add to open project"
  // import) instead of opening it in its own tab. The editor watches the token.
  const addToEditor = useCallback((loaded: Loaded) => {
    const built = buildProject(loaded);
    const tracks = built.tracks.length
      ? built.tracks
      : loaded.set
        ? fromStemSet(loaded.set).tracks
        : [];
    if (tracks.length) {
      importTokenRef.current += 1;
      setPendingImport({ tracks, token: importTokenRef.current });
    }
    setMobileEdit(true); // ensure the editor (not the mixer) is showing on mobile
    setJob({ running: false });
    setModal(null);
  }, []);

  // Run a project-loading task inside the active modal. mode 'new' opens the
  // result in its own tab; mode 'add' appends it to the current one.
  const runInModal = useCallback(
    async (fn: () => Promise<Loaded>, mode: ImportMode = 'new') => {
      cancelledRef.current = false;
      setJob({ running: true, progress: { phase: 'extracting', percent: 0 } });
      // Hold a screen wake lock for the whole job: on mobile an auto screen-lock
      // suspends the WebView and kills the in-flight cloud separation request.
      const releaseWakeLock = keepScreenAwake();
      try {
        const loaded = await fn();
        if (cancelledRef.current) return;
        if (mode === 'add' && activeIdRef.current) addToEditor(loaded);
        else openInTab(loaded);
      } catch (err) {
        if (cancelledRef.current) return;
        setJob({ running: false, error: err instanceof Error ? err.message : String(err) });
      } finally {
        releaseWakeLock();
      }
    },
    [openInTab, addToEditor],
  );

  const start = useCallback(
    (config: JobConfig, file: File | null, mode: ImportMode = 'new') =>
      runInModal(async () => {
        const { set, project, title: t } = await runJob(config, file, onProgress);
        return { title: t, set, project };
      }, mode),
    [runInModal, onProgress],
  );

  const splitSource = useCallback(
    (source: SourceMeta, useCloud = false, stems?: SelectableStem[]) =>
      runInModal(async () => {
        const { set, project } = await splitSavedSource(source, backendUrl, onProgress, useCloud, stems);
        return { title: source.title, set, project };
      }),
    [runInModal, backendUrl, onProgress],
  );

  const openProject = useCallback(
    (p: ProjectMeta) =>
      runInModal(async () => {
        const set = await store.loadProject(p, onProgress);
        return { title: p.title, set };
      }),
    [runInModal, onProgress],
  );

  const openArrangement = useCallback(
    (a: ArrangementSummary) => runInModal(() => store.loadArrangement(a.id, onProgress)),
    [runInModal, onProgress],
  );

  /* ---------- the project file ---------- */

  /** Run a background job through the modal's progress panel. */
  const runTask = useCallback(async (fn: () => Promise<void>) => {
    cancelledRef.current = false;
    setJob({ running: true, progress: { phase: 'extracting', percent: 0 } });
    try {
      await fn();
      setJob({ running: false });
    } catch (err) {
      if (cancelledRef.current) return;
      setJob({ running: false, error: err instanceof Error ? err.message : String(err) });
    }
  }, []);

  /** Every open tab as the workspace serializer wants it, newest state first. */
  const collectTabs = useCallback((): WorkspaceTab[] => {
    const out: WorkspaceTab[] = [];
    for (const meta of tabs) {
      const content = contentRef.current.get(meta.id);
      if (!content) continue;
      // A mobile quick-mixer tab hasn't built its editor project yet; build it
      // now so what lands in the file is the same for every platform.
      const project = content.project.tracks.length
        ? content.project
        : content.set
          ? fromStemSet(content.set)
          : content.project;
      out.push({ title: meta.title, project });
    }
    return out;
  }, [tabs]);

  const writeWorkspace = useCallback(
    (target: ProjectFile) =>
      runTask(async () => {
        const blob = await serializeWorkspace(
          collectTabs(),
          Math.max(0, tabs.findIndex((t) => t.id === activeIdRef.current)),
          onProgress,
        );
        await writeProjectFile(target, blob);
        setProjectFile(target);
        setProjectSavedAt(new Date().toISOString());
        setProjectDirty(false);
        // The session is on disk, so no tab has unsaved work in the sense the
        // dots mean any more.
        setTabs((prev) => (prev.some((t) => t.dirty) ? prev.map((t) => ({ ...t, dirty: false })) : prev));
      }),
    [runTask, collectTabs, tabs, onProgress],
  );

  const saveProjectAs = useCallback(async () => {
    if (!tabs.length) return;
    // Ask before packing: the picker needs the click that opened it.
    const target = await pickSaveTarget(workspaceFilename(tabs[0]?.title ?? 'project'));
    if (target) void writeWorkspace(target);
  }, [tabs, writeWorkspace]);

  const saveProject = useCallback(() => {
    if (!tabs.length) return;
    if (projectFile?.handle) void writeWorkspace(projectFile);
    else void saveProjectAs();
  }, [tabs.length, projectFile, writeWorkspace, saveProjectAs]);

  /** Replace the whole session with the tabs from a project file. */
  const adoptWorkspace = useCallback(
    (loadedTabs: WorkspaceTab[], activeIndex: number, file: ProjectFile, savedAt?: string) => {
      const next = new Map<string, TabContent>();
      const metas: TabMeta[] = loadedTabs.map((t) => {
        const id = uid();
        next.set(id, { project: t.project });
        return { id, title: t.title, dirty: false };
      });
      contentRef.current = next;
      setTabs(metas);
      setProjectFile(file);
      setProjectSavedAt(savedAt ?? null);
      setProjectDirty(false);
      const active = metas[activeIndex] ?? metas[0];
      if (active) showTab(active.id);
    },
    [showTab],
  );

  const openProjectFileFlow = useCallback(async () => {
    if (
      projectDirty &&
      tabs.length &&
      !window.confirm('Open a project file? Everything currently open will be closed.')
    ) {
      return;
    }
    const picked = await openProjectFile();
    if (!picked) return;
    setModal('project');
    void runTask(async () => {
      const ws = await parseWorkspace(picked.file, onProgress);
      adoptWorkspace(ws.tabs, ws.activeIndex, picked.project, ws.savedAt);
    });
  }, [projectDirty, tabs.length, runTask, onProgress, adoptWorkspace]);

  /** Close everything and start from nothing. */
  const newProject = useCallback(() => {
    if (
      projectDirty &&
      tabs.length &&
      !window.confirm('Start a new project? Everything currently open will be closed.')
    ) {
      return;
    }
    contentRef.current = new Map();
    setTabs([]);
    activeIdRef.current = null;
    setActiveId(null);
    setProject(emptyProject());
    setStemSet(null);
    setSessionId((s) => s + 1);
    setProjectFile(null);
    setProjectSavedAt(null);
    setProjectDirty(false);
    setModal('import');
  }, [projectDirty, tabs.length]);

  /** What the Project panel reports. Recomputed when it opens, which is enough:
   *  tab projects live in a ref and don't re-render the shell as they change. */
  const projectStatus = useMemo(() => {
    let trackCount = 0;
    let estimatedBytes = 0;
    const built: WorkspaceTab[] = [];
    for (const meta of tabs) {
      const content = contentRef.current.get(meta.id);
      if (!content) continue;
      if (content.project.tracks.length) {
        built.push({ title: meta.title, project: content.project });
        trackCount += content.project.tracks.length;
      } else if (content.set) {
        // Mobile lazy tab: size it from the stem set rather than building the
        // audio just to measure it.
        trackCount += content.set.stems.length;
        estimatedBytes +=
          content.set.stems.length * (44 + content.set.length * content.set.numChannels * 2);
      }
    }
    return {
      tabTitles: tabs.map((t) => t.title),
      trackCount,
      estimatedBytes: estimatedBytes + estimateWorkspaceBytes(built),
      fileName: projectFile?.name ?? null,
      savedAt: projectSavedAt,
      dirty: projectDirty,
      canWriteInPlace: canWriteInPlace(),
    };
    // `modal` is in here on purpose: it is the signal that the panel just opened.
  }, [tabs, modal, projectFile, projectSavedAt, projectDirty]);

  const closeModal = useCallback(() => {
    if (job.running) cancelledRef.current = true;
    setJob({ running: false });
    setModal(null);
  }, [job.running]);

  function modalInner(view: View) {
    if (job.running) {
      return (
        <ProgressPanel
          progress={job.progress ?? { phase: 'extracting', percent: 0 }}
          onCancel={closeModal}
        />
      );
    }
    if (job.error) {
      return (
        <div className="panel">
          <h2>Something went wrong</h2>
          <p className="err">{job.error}</p>
          <p className="hint">
            If YouTube extraction failed, try the file-upload path — it works without any server.
          </p>
          <button className="btn" onClick={() => setJob({ running: false })}>
            ← Back
          </button>
        </div>
      );
    }
    if (view === 'import')
      return (
        <StartPanel onStart={start} backendUrl={backendUrl} canAddToProject={activeId !== null} />
      );
    if (view === 'library') {
      return (
        <LibraryPanel
          onOpenProject={openProject}
          onSplitSource={splitSource}
          onOpenArrangement={openArrangement}
          reloadKey={reloadKey}
        />
      );
    }
    if (view === 'project') {
      return (
        <ProjectPanel
          status={projectStatus}
          onSave={saveProject}
          onSaveAs={saveProjectAs}
          onOpen={openProjectFileFlow}
          onNew={newProject}
        />
      );
    }
    return <OptionsPanel backendUrl={backendUrl} onBackendUrlChange={setBackendUrl} />;
  }

  // On mobile, a completed split shows the simple faders mixer; the full DAW
  // editor is opt-in. Desktop always uses the editor.
  const showMixer = IS_MOBILE && !!stemSet && !mobileEdit;

  return (
    <div className="app-shell">
      {/* Floating hamburger — only visible on small screens (see globals.css). */}
      <button className="mobile-nav-open" onClick={toggleNav} aria-label="Open menu">
        <Menu size={20} />
      </button>

      {/* Mobile-only toggle between the quick mixer and the full editor. */}
      {IS_MOBILE && stemSet && (
        <button className="mobile-view-toggle" onClick={toggleMobileEdit}>
          {mobileEdit ? '◂ Mixer' : 'Editor ▸'}
        </button>
      )}

      {/* Backdrop behind the mobile drawer; tapping it closes the drawer. */}
      {navOpen && <div className="drawer-backdrop" onClick={toggleNav} />}

      <aside className={`sidebar${navOpen ? '' : ' collapsed'}`}>
        <button
          className="nav-toggle"
          onClick={toggleNav}
          title={navOpen ? 'Collapse menu' : 'Expand menu'}
          aria-label={navOpen ? 'Collapse menu' : 'Expand menu'}
        >
          {navOpen ? <ChevronsLeft size={18} /> : <Menu size={18} />}
        </button>
        <div className="brand">
          <span className="brand-icon">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icon.png" alt="Prismaxim" width={32} height={32} />
          </span>
          <span className="label">Prismaxim</span>
        </div>
        <nav>
          {(['import', 'library', 'project', 'options'] as View[]).map((v) => (
            <button
              key={v}
              className={`nav-btn${modal === v ? ' active' : ''}`}
              onClick={() => selectView(v)}
              title={TITLES[v]}
            >
              <span className="nav-icon">
                {v === 'import' ? (
                  <Download size={17} />
                ) : v === 'library' ? (
                  <Library size={17} />
                ) : v === 'project' ? (
                  <FolderOpen size={17} />
                ) : (
                  <Settings size={17} />
                )}
              </span>
              <span className="label">{TITLES[v]}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          Demucs (htdemucs_6s) 6-stem separation. For personal use — respect copyright and
          YouTube&apos;s Terms of Service.
        </div>
      </aside>

      <main className={`app-main${showMixer ? ' mixer-mode' : ''}`}>
        {/* Always mounted, even with nothing open: ＋ is how an empty project or
            the first song gets opened. */}
        <TabBar
          tabs={tabs}
          activeId={activeId}
          onSelect={showTab}
          onClose={closeTab}
          onNew={() => selectView('import')}
          onNewEmpty={openEmptyTab}
          onMerge={mergeTab}
        />
        {showMixer && stemSet ? (
          <Mixer set={stemSet} title={title} persisted onReset={() => selectView('import')} />
        ) : (
          <Editor
            key={sessionId}
            initialProject={project}
            initialDirty={tabs.find((t) => t.id === activeId)?.dirty}
            songId={activeId ?? undefined}
            title={title}
            onImport={() => selectView('import')}
            pendingImport={pendingImport}
            onProjectChange={mirrorProject}
            onSaved={() => {
              markDirty(false);
              setReloadKey((k) => k + 1);
            }}
            onDirtyChange={markDirty}
          />
        )}
      </main>

      {modal && (
        <div className="modal-backdrop">
          <div className={`modal modal-${modal}`} onPointerDown={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>{TITLES[modal]}</span>
              <button className="modal-close" onClick={closeModal} title="Close">
                <X size={16} />
              </button>
            </div>
            <div className="modal-body">{modalInner(modal)}</div>
          </div>
        </div>
      )}
    </div>
  );
}
