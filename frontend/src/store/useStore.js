/**
 * TFGen global store — Zustand with temporal middleware for undo/redo.
 *
 * Slices:
 *  - graph:     ResourceGraph (nodes + edges + layout)
 *  - project:   project metadata (name, region, environment, backend)
 *  - ui:        selected node, panel state, active mode flags
 *  - execution: plan job state, log lines, cost + security results
 */
import { create } from 'zustand';
import { temporal } from 'zundo';

// --- Resource Graph slice -----------------------------------------------------
const createGraphSlice = (set, get) => ({
  nodes:  [],
  edges:  [],
  layout: {},

  addNode(node) {
    set(state => ({ nodes: [...state.nodes, node] }));
  },

  updateNode(id, patch) {
    set(state => ({
      nodes: state.nodes.map(n => n.id === id ? { ...n, ...patch } : n),
    }));
  },

  removeNode(id) {
    set(state => ({
      nodes: state.nodes.filter(n => n.id !== id),
      edges: state.edges.filter(e => e.source !== id && e.target !== id),
    }));
  },

  addEdge(edge) {
    set(state => ({ edges: [...state.edges, edge] }));
  },

  removeEdge(id) {
    set(state => ({ edges: state.edges.filter(e => e.id !== id) }));
  },

  updateNodePosition(id, x, y) {
    set(state => ({
      layout: { ...state.layout, [id]: { x, y } },
      nodes:  state.nodes.map(n => n.id === id ? { ...n, position: { x, y } } : n),
    }));
  },

  setNodes(nodes) { set({ nodes }); },
  setEdges(edges) { set({ edges }); },

  /** Replace entire graph (e.g. on project load).
   *  Also marks resourcesLoaded=true so advanced-mode panels know the API
   *  data has arrived (BUG-018 flash-suppression). */
  loadGraph({ nodes = [], edges = [], layout = {} }) {
    set({ nodes, edges, layout, resourcesLoaded: true });
  },
});

// --- Project slice -------------------------------------------------------------
const createProjectSlice = (set) => ({
  project:       null,
  awsRegion:     'ap-south-1',
  environment:   'dev',
  backendConfig: {},
  projectName:   '',

  setProject(project) {
    set({
      project,
      awsRegion:     project?.aws_region     || 'ap-south-1',
      environment:   project?.environment    || 'dev',
      backendConfig: project?.backend_config || {},
      projectName:   project?.name           || '',
    });
  },

  updateProjectMeta(patch) {
    set(state => ({
      project:       state.project ? { ...state.project, ...patch } : state.project,
      awsRegion:     patch.aws_region     ?? state.awsRegion,
      environment:   patch.environment    ?? state.environment,
      backendConfig: patch.backend_config ?? state.backendConfig,
      projectName:   patch.name           ?? state.projectName,
    }));
  },
});

// --- UI slice ------------------------------------------------------------------
const createUISlice = (set) => ({
  selectedNodeId:  null,
  // BUG-018: advancedMode is persisted in localStorage so it survives page
  // reloads.  On mount, nodes/edges are still empty (they come from the API),
  // which means the advanced-mode panels would render briefly against an empty
  // graph.  We suppress that flash with `resourcesLoaded` — components that
  // render advanced-mode content should gate on both flags.
  advancedMode:    localStorage.getItem('tfgen.advancedMode') === 'true',
  resourcesLoaded: false,   // set to true once the project graph arrives from the API
  showValidPanel:  false,
  validType:       null,   // 'fmt' | 'validate' | 'plan'
  saving:          false,
  activeTab:       'config', // 'config' | 'variables' | 'outputs' | 'lifecycle'

  selectNode:          (id)    => set({ selectedNodeId: id }),
  setAdvancedMode:     (v)     => { set({ advancedMode: v }); localStorage.setItem('tfgen.advancedMode', v ? 'true' : 'false'); },
  setResourcesLoaded:  (v)     => set({ resourcesLoaded: v }),
  setShowValidPanel:   (v)     => set({ showValidPanel: v }),
  setValidType:        (t)     => set({ validType: t }),
  setSaving:           (v)     => set({ saving: v }),
  setActiveTab:        (tab)   => set({ activeTab: tab }),
});

// --- Execution slice -----------------------------------------------------------
const createExecutionSlice = (set) => ({
  validResult:    null,
  validLoading:   false,
  planJobId:      null,
  logLines:       [],
  planDiff:       null,   // { summary, resource_changes }
  checkovResult:  null,   // { passed, failed, findings[] }
  costEstimate:   null,   // { total_monthly_usd, items[] }
  networkWarnings: [],

  setValidResult:      (r)  => set({ validResult: r }),
  setValidLoading:     (v)  => set({ validLoading: v }),
  setPlanJobId:        (id) => set({ planJobId: id }),
  appendLogLine:       (ln) => set(state => ({ logLines: [...state.logLines.slice(-500), ln] })),
  clearLogs:           ()   => set({ logLines: [] }),
  setPlanDiff:         (d)  => set({ planDiff: d }),
  setCheckovResult:    (r)  => set({ checkovResult: r }),
  setCostEstimate:     (r)  => set({ costEstimate: r }),
  setNetworkWarnings:  (w)  => set({ networkWarnings: w }),
  resetExecution:      ()   => set({ validResult: null, planDiff: null, logLines: [], planJobId: null }),
});

// --- Compose store with temporal middleware (undo/redo on graph changes) ------
const useStore = create(
  temporal(
    (set, get) => ({
      ...createGraphSlice(set, get),
      ...createProjectSlice(set),
      ...createUISlice(set),
      ...createExecutionSlice(set),
    }),
    {
      // Only track graph mutations for undo/redo — not UI or execution state
      partialize: (state) => ({
        nodes:  state.nodes,
        edges:  state.edges,
        layout: state.layout,
      }),
      limit: 50, // keep last 50 graph snapshots
    }
  )
);

export default useStore;

/**
 * Undo/redo helpers — call from keyboard shortcut handler.
 */
export const undo = () => useStore.temporal.getState().undo();
export const redo = () => useStore.temporal.getState().redo();
export const canUndo = () => useStore.temporal.getState().pastStates.length > 0;
export const canRedo = () => useStore.temporal.getState().futureStates.length > 0;
