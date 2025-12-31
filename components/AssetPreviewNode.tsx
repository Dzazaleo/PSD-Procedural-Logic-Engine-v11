import React, { memo, useEffect, useMemo, useState } from 'react';
import { Handle, Position, NodeProps, NodeResizer, useEdges, useReactFlow, useUpdateNodeInternals } from 'reactflow';
import { PSDNodeData, AssetPreviewInstanceState, TransformedPayload, PreviewMode } from '../types';
import { useProceduralStore } from '../store/ProceduralContext';
import { Eye, CheckCircle2, XCircle, LayoutGrid, Box, Cpu, FileJson, ArrowRightLeft } from 'lucide-react';

// --- Helper: Audit Badge ---
const AuditBadge = ({ count, label, icon: Icon, colorClass }: { count: number, label: string, icon: any, colorClass: string }) => (
    <div className={`flex items-center space-x-1.5 px-2 py-1 rounded border ${colorClass} bg-opacity-20`}>
        <Icon className="w-3 h-3" />
        <span className="text-[9px] font-mono font-bold">{count} {label}</span>
    </div>
);

// --- Subcomponent: Preview Instance Row ---
interface PreviewInstanceRowProps {
    index: number;
    nodeId: string;
    state: AssetPreviewInstanceState;
    edges: any[];
    payloadRegistry: any;
    reviewerRegistry: any;
    onToggle: (index: number, mode: PreviewMode) => void;
}

const PreviewInstanceRow: React.FC<PreviewInstanceRowProps> = ({ 
    index, 
    nodeId, 
    state, 
    edges, 
    payloadRegistry, 
    reviewerRegistry, 
    onToggle 
}) => {
    const { registerPreviewPayload } = useProceduralStore();
    
    // 1. Trace Upstream (Reviewer)
    const upstreamEdge = useMemo(() => 
        edges.find((e: any) => e.target === nodeId && e.targetHandle === `payload-in-${index}`),
    [edges, nodeId, index]);

    const reviewerNodeId = upstreamEdge?.source;
    const reviewerHandleId = upstreamEdge?.sourceHandle; // e.g., 'polished-out-0'

    // 2. Trace Origin (Remapper via Reviewer)
    const originEdge = useMemo(() => {
        if (!reviewerNodeId || !reviewerHandleId) return null;
        // Reviewer handle format: 'polished-out-X'. Input handle is 'payload-in-X'.
        const reviewerIndex = reviewerHandleId.split('-').pop();
        return edges.find((e: any) => e.target === reviewerNodeId && e.targetHandle === `payload-in-${reviewerIndex}`);
    }, [edges, reviewerNodeId, reviewerHandleId]);

    // 3. Resolve Payloads
    const polishedPayload: TransformedPayload | undefined = (reviewerNodeId && reviewerHandleId) 
        ? reviewerRegistry[reviewerNodeId]?.[reviewerHandleId] 
        : undefined;

    const proceduralPayload: TransformedPayload | undefined = (originEdge)
        ? payloadRegistry[originEdge.source]?.[originEdge.sourceHandle || '']
        : undefined;

    // 4. Select Active Payload
    const activePayload = state.currentMode === 'POLISHED' ? polishedPayload : proceduralPayload;
    
    // Fallback: If 'Polished' is selected but missing (e.g., unconnected), revert to Procedural or null
    const displayPayload = activePayload || proceduralPayload; 
    const isPolishedAvailable = !!polishedPayload;
    const isProceduralAvailable = !!proceduralPayload;

    // 5. Broadcast Selection to Store (Output)
    useEffect(() => {
        if (displayPayload) {
            registerPreviewPayload(nodeId, `preview-out-${index}`, displayPayload);
        }
    }, [displayPayload, nodeId, index, registerPreviewPayload]);

    // Stats
    const layerCount = displayPayload?.layers?.length || 0;
    const containerName = displayPayload?.targetContainer || 'Unknown';
    const dims = displayPayload?.metrics?.target || { w: 0, h: 0 };
    const scale = displayPayload?.scaleFactor || 1;

    // Calculate Layer Breakdown
    const breakdown = useMemo(() => {
        let pixel = 0, group = 0, gen = 0;
        const traverse = (layers: any[]) => {
            layers.forEach(l => {
                if (l.type === 'generative') gen++;
                else if (l.type === 'group') group++;
                else pixel++;
                if (l.children) traverse(l.children);
            });
        };
        if (displayPayload?.layers) traverse(displayPayload.layers);
        return { pixel, group, gen };
    }, [displayPayload]);

    return (
        <div className="p-3 bg-slate-800/50 border-b border-emerald-900/30 space-y-3">
             {/* Header / Connection Status */}
             <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                    <Handle 
                        type="target" 
                        position={Position.Left} 
                        id={`payload-in-${index}`} 
                        className={`!static !w-2.5 !h-2.5 !border-2 ${upstreamEdge ? '!bg-indigo-500 !border-white' : '!bg-slate-700 !border-slate-500'}`} 
                    />
                    <span className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">
                        {upstreamEdge ? (displayPayload?.targetContainer || 'Connected') : 'Connect Reviewer'}
                    </span>
                </div>
                {displayPayload && (
                    <span className="text-[9px] font-mono text-slate-500">
                        {Math.round(dims.w)}x{Math.round(dims.h)} • {scale.toFixed(2)}x
                    </span>
                )}
             </div>

             {/* Semantic Toggle */}
             <div className="flex bg-slate-900 p-1 rounded border border-slate-700">
                 <button
                    onClick={() => onToggle(index, 'PROCEDURAL')}
                    disabled={!isProceduralAvailable}
                    className={`flex-1 py-1.5 text-[9px] font-bold uppercase tracking-wider rounded flex items-center justify-center space-x-1 transition-all ${
                        state.currentMode === 'PROCEDURAL' 
                            ? 'bg-indigo-600 text-white shadow-sm' 
                            : 'text-slate-500 hover:text-slate-300'
                    } ${!isProceduralAvailable ? 'opacity-50 cursor-not-allowed' : ''}`}
                 >
                     <LayoutGrid className="w-3 h-3" />
                     <span>Procedural</span>
                 </button>
                 
                 <div className="w-px bg-slate-700 mx-1"></div>

                 <button
                    onClick={() => onToggle(index, 'POLISHED')}
                    disabled={!isPolishedAvailable}
                    className={`flex-1 py-1.5 text-[9px] font-bold uppercase tracking-wider rounded flex items-center justify-center space-x-1 transition-all ${
                        state.currentMode === 'POLISHED' 
                            ? 'bg-emerald-600 text-white shadow-sm' 
                            : 'text-slate-500 hover:text-slate-300'
                    } ${!isPolishedAvailable ? 'opacity-50 cursor-not-allowed' : ''}`}
                 >
                     <CheckCircle2 className="w-3 h-3" />
                     <span>Polished</span>
                 </button>
             </div>

             {/* Visualization Area */}
             <div className="relative w-full h-48 bg-[#333333] rounded border border-slate-600 overflow-hidden flex items-center justify-center shadow-inner group">
                 {/* Checkerboard Pattern */}
                 <div className="absolute inset-0 opacity-10 pointer-events-none" 
                      style={{ backgroundImage: 'linear-gradient(45deg, #444 25%, transparent 25%), linear-gradient(-45deg, #444 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #444 75%), linear-gradient(-45deg, transparent 75%, #444 75%)', backgroundSize: '20px 20px', backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px' }} 
                 />

                 {!displayPayload ? (
                     <div className="text-xs text-neutral-500 font-mono">Waiting for Payload...</div>
                 ) : (
                     <div className="relative w-full h-full p-4 flex items-center justify-center">
                         {/* Placeholder for Canvas - In Phase 5 we'd render the actual layout here */}
                         {/* For now, we show the Preview URL (AI Ghost) if present, or a placeholder box */}
                         {displayPayload.previewUrl ? (
                             <img src={displayPayload.previewUrl} alt="Preview" className="max-w-full max-h-full object-contain shadow-lg" />
                         ) : (
                             <div 
                                className="border-2 border-dashed border-neutral-500/50 flex items-center justify-center bg-neutral-800/50 text-neutral-400 font-mono text-[9px] p-4 text-center"
                                style={{ 
                                    aspectRatio: `${dims.w} / ${dims.h}`, 
                                    height: dims.h > dims.w ? '80%' : 'auto', 
                                    width: dims.w >= dims.h ? '80%' : 'auto' 
                                }}
                             >
                                 <div className="flex flex-col items-center gap-1">
                                    <span>LAYOUT GEOMETRY</span>
                                    <span>{Math.round(dims.w)} x {Math.round(dims.h)}</span>
                                 </div>
                             </div>
                         )}
                         
                         {/* Status Overlay */}
                         <div className="absolute bottom-2 right-2 flex space-x-1">
                             <span className={`text-[8px] px-1.5 py-0.5 rounded font-bold uppercase backdrop-blur-md shadow-sm border ${
                                 state.currentMode === 'POLISHED' 
                                     ? 'bg-emerald-500/80 text-white border-emerald-400' 
                                     : 'bg-indigo-500/80 text-white border-indigo-400'
                             }`}>
                                 {state.currentMode} VIEW
                             </span>
                         </div>
                     </div>
                 )}
             </div>

             {/* Process Audit Footer */}
             {displayPayload && (
                 <div className="flex flex-wrap gap-2 pt-1">
                     <AuditBadge count={breakdown.pixel} label="Pixel" icon={FileJson} colorClass="bg-slate-700 border-slate-600 text-slate-300" />
                     <AuditBadge count={breakdown.group} label="Groups" icon={Box} colorClass="bg-slate-700 border-slate-600 text-slate-300" />
                     {breakdown.gen > 0 && (
                         <AuditBadge count={breakdown.gen} label="AI Gen" icon={Cpu} colorClass="bg-purple-900 border-purple-500 text-purple-300" />
                     )}
                 </div>
             )}

             {/* Output Handle */}
             <div className="flex justify-end pt-1 relative">
                 <div className="flex items-center space-x-1 pr-2">
                     <span className="text-[9px] text-emerald-500 font-bold tracking-widest uppercase">To Export</span>
                     <ArrowRightLeft className="w-3 h-3 text-emerald-600" />
                 </div>
                 <Handle 
                    type="source" 
                    position={Position.Right} 
                    id={`preview-out-${index}`} 
                    className={`!absolute !right-[-12px] !top-1/2 !-translate-y-1/2 !w-3 !h-3 !border-2 ${displayPayload ? '!bg-emerald-500 !border-white' : '!bg-slate-700 !border-slate-500'}`} 
                 />
             </div>
        </div>
    );
};

export const AssetPreviewNode = memo(({ id, data }: NodeProps<PSDNodeData>) => {
  const instanceCount = data.instanceCount || 1;
  const previewInstances = data.previewInstances || {};
  
  const { setNodes } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const edges = useEdges();
  
  // Store Access
  const { payloadRegistry, reviewerRegistry, unregisterNode } = useProceduralStore();

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, instanceCount, updateNodeInternals]);

  useEffect(() => {
    return () => unregisterNode(id);
  }, [id, unregisterNode]);

  const handleToggle = (index: number, mode: PreviewMode) => {
      setNodes(nds => nds.map(n => {
          if (n.id === id) {
              const currentInstances = n.data.previewInstances || {};
              return {
                  ...n,
                  data: {
                      ...n.data,
                      previewInstances: {
                          ...currentInstances,
                          [index]: { currentMode: mode }
                      }
                  }
              };
          }
          return n;
      }));
  };

  const addInstance = () => {
      setNodes(nds => nds.map(n => n.id === id ? { ...n, data: { ...n.data, instanceCount: instanceCount + 1 } } : n));
  };

  return (
    <div className="w-[420px] bg-slate-900 rounded-lg shadow-2xl border border-emerald-500/30 font-sans flex flex-col overflow-hidden">
      <NodeResizer minWidth={420} minHeight={300} isVisible={true} lineStyle={{ border: 'none' }} handleStyle={{ background: 'transparent' }} />
      
      {/* Header */}
      <div className="bg-emerald-950/90 p-2 border-b border-emerald-500/50 flex items-center justify-between">
         <div className="flex items-center space-x-2">
           <Eye className="w-4 h-4 text-emerald-400" />
           <div className="flex flex-col leading-none">
             <span className="text-sm font-bold text-emerald-100 tracking-tight">Asset Preview</span>
             <span className="text-[9px] text-emerald-500/70 font-mono">GATEKEEPER</span>
           </div>
         </div>
      </div>

      <div className="flex flex-col">
          {Array.from({ length: instanceCount }).map((_, i) => (
              <PreviewInstanceRow 
                  key={i} 
                  index={i} 
                  nodeId={id}
                  state={previewInstances[i] || { currentMode: 'PROCEDURAL' }}
                  edges={edges}
                  payloadRegistry={payloadRegistry}
                  reviewerRegistry={reviewerRegistry}
                  onToggle={handleToggle}
              />
          ))}
      </div>

      <button onClick={addInstance} className="w-full py-2 bg-slate-900 hover:bg-slate-800 text-emerald-600 hover:text-emerald-400 text-[9px] font-bold uppercase tracking-widest transition-colors flex items-center justify-center space-x-2 border-t border-emerald-900/30">
          <LayoutGrid className="w-3 h-3" />
          <span>Add Preview Slot</span>
      </button>
    </div>
  );
});