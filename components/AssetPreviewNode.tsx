import React, { memo, useEffect, useMemo, useState } from 'react';
import { Handle, Position, NodeProps, NodeResizer, useEdges, useReactFlow, useUpdateNodeInternals, Edge } from 'reactflow';
import { PSDNodeData, AssetPreviewInstanceState, TransformedPayload, PreviewMode, TransformedLayer, TemplateMetadata } from '../types';
import { useProceduralStore } from '../store/ProceduralContext';
import { findLayerByPath } from '../services/psdService';
import { Eye, CheckCircle2, LayoutGrid, Box, Cpu, FileJson, ArrowRightLeft, Zap, Lock, AlertTriangle } from 'lucide-react';
import { Psd, Layer } from 'ag-psd';

// --- Helper: Audit Badge ---
const AuditBadge = ({ count, label, icon: Icon, colorClass }: { count: number, label: string, icon: any, colorClass: string }) => (
    <div className={`flex items-center space-x-1.5 px-2 py-1 rounded border ${colorClass} bg-opacity-20`}>
        <Icon className="w-3 h-3" />
        <span className="text-[9px] font-mono font-bold">{count} {label}</span>
    </div>
);

// --- Helper: Recursive Pixel Search ---
// Fallback mechanism to find pixel data by name if strict path lookups fail due to structural mutations.
const findPixelsRecursive = (children: Layer[] | undefined, targetName: string): HTMLCanvasElement | null => {
    if (!children) return null;
    for (const layer of children) {
        if (layer.name === targetName && layer.canvas) {
            return layer.canvas as HTMLCanvasElement;
        }
        if (layer.children) {
            const found = findPixelsRecursive(layer.children, targetName);
            if (found) return found;
        }
    }
    return null;
};

// --- Interface Definition ---
interface PreviewInstanceRowProps {
    index: number;
    nodeId: string;
    state: AssetPreviewInstanceState;
    edges: Edge[];
    payloadRegistry: Record<string, Record<string, TransformedPayload>>;
    reviewerRegistry: Record<string, Record<string, TransformedPayload>>;
    psdRegistry: Record<string, Psd>;
    templateRegistry: Record<string, TemplateMetadata>;
    globalVersion: number;
    onToggle: (index: number, mode: PreviewMode) => void;
}

// --- Subcomponent: Preview Instance Row ---
const PreviewInstanceRow: React.FC<PreviewInstanceRowProps> = ({ 
    index, 
    nodeId, 
    state, 
    edges, 
    payloadRegistry, 
    reviewerRegistry, 
    psdRegistry,
    templateRegistry,
    globalVersion,
    onToggle 
}) => {
    // We use registerReviewerPayload to alias this node as a 'Reviewer' for the Export Node's strict gate
    const { registerReviewerPayload } = useProceduralStore();
    const [localPreview, setLocalPreview] = useState<string | null>(null);
    const [renderError, setRenderError] = useState<string | null>(null);
    
    // 1. Trace Upstream (Reviewer Connection)
    const upstreamEdge = useMemo(() => 
        edges.find((e) => e.target === nodeId && e.targetHandle === `payload-in-${index}`),
    [edges, nodeId, index]);

    // 2. Resolve Polished Payload (Directly from the connected Reviewer)
    const polishedPayload: TransformedPayload | undefined = useMemo(() => {
        if (!upstreamEdge) return undefined;
        return reviewerRegistry[upstreamEdge.source]?.[upstreamEdge.sourceHandle || ''];
    }, [upstreamEdge, reviewerRegistry]);

    // 3. Resolve Procedural Payload (Trace back to the Grandparent Remapper)
    const proceduralPayload: TransformedPayload | undefined = useMemo(() => {
        if (!upstreamEdge) return undefined;

        const upstreamInputHandle = upstreamEdge.sourceHandle?.replace('polished-out', 'payload-in');
        
        if (upstreamInputHandle) {
            const grandparentEdge = edges.find(
                e => e.target === upstreamEdge.source && e.targetHandle === upstreamInputHandle
            );
            
            if (grandparentEdge) {
                return payloadRegistry[grandparentEdge.source]?.[grandparentEdge.sourceHandle || ''];
            }
        }
        
        return payloadRegistry[upstreamEdge.source]?.[upstreamEdge.sourceHandle || ''];

    }, [upstreamEdge, edges, payloadRegistry]);

    // 4. Select Active Payload based on State Selection
    const activeMode = state.currentMode;
    let displayPayload: TransformedPayload | undefined;
    
    if (activeMode === 'POLISHED') {
        displayPayload = polishedPayload;
    } else {
        displayPayload = proceduralPayload;
    }

    const isPolishedAvailable = !!polishedPayload;
    const isProceduralAvailable = !!proceduralPayload;

    // 5. Broadcast "Production Gate" Selection
    useEffect(() => {
        if (displayPayload) {
            const signedOffPayload = { ...displayPayload, isPolished: true };
            registerReviewerPayload(nodeId, `preview-out-${index}`, signedOffPayload);
        }
    }, [displayPayload, nodeId, index, registerReviewerPayload]);

    // 6. SURGICAL COMPOSITOR LOGIC
    useEffect(() => {
        if (!displayPayload) {
            setLocalPreview(null);
            setRenderError(null);
            return;
        }

        const sourceNodeId = displayPayload.sourceNodeId;
        const psd = psdRegistry[sourceNodeId];

        // BINARY READINESS GATE
        // If the registry entry is missing (e.g. during re-upload), abort update to prevent blanking out the canvas.
        if (!psd) {
            // Fallback: If we have an AI preview URL, display it, otherwise keep previous state if possible.
            if (displayPayload.previewUrl) {
                setLocalPreview(displayPayload.previewUrl);
            }
            return; 
        }

        const { w, h } = displayPayload.metrics.target;
        if (w === 0 || h === 0) return;

        // --- COORDINATE NORMALIZATION ---
        let originX = 0;
        let originY = 0;
        let foundContainer = false;

        const allTemplates = Object.values(templateRegistry) as TemplateMetadata[];
        
        for (const tmpl of allTemplates) {
            const cont = tmpl.containers.find(c => c.name === displayPayload?.targetContainer);
            if (cont) {
                originX = cont.bounds.x;
                originY = cont.bounds.y;
                foundContainer = true;
                break;
            }
        }

        // Fallback Guess logic remains same...
        if (!foundContainer && displayPayload.layers.length > 0) {
            let minX = Infinity;
            let minY = Infinity;
            const findMin = (layers: TransformedLayer[]) => {
                layers.forEach(l => {
                    if (l.isVisible) {
                        if (l.coords.x < minX) minX = l.coords.x;
                        if (l.coords.y < minY) minY = l.coords.y;
                        if (l.children) findMin(l.children);
                    }
                });
            };
            findMin(displayPayload.layers);
            if (minX !== Infinity) originX = minX;
            if (minY !== Infinity) originY = minY;
        }

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Background: Solid Dark Slate
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, w, h);

        const drawLayers = (layers: TransformedLayer[]) => {
            // Reverse Painter's Algorithm (Bottom-Up)
            for (let i = layers.length - 1; i >= 0; i--) {
                const layer = layers[i];
                if (!layer.isVisible) continue;

                if (layer.children) {
                    drawLayers(layer.children);
                }

                // --- STRICT TRANSFORMATION BANKING ---
                ctx.save();
                
                if (layer.type === 'generative') {
                    // Normalize Coordinates relative to Origin
                    const localX = layer.coords.x - originX;
                    const localY = layer.coords.y - originY;

                    ctx.fillStyle = 'rgba(192, 132, 252, 0.2)';
                    ctx.strokeStyle = 'rgba(192, 132, 252, 0.6)';
                    ctx.setLineDash([4, 4]);
                    ctx.lineWidth = 1;
                    ctx.fillRect(localX, localY, layer.coords.w, layer.coords.h);
                    ctx.strokeRect(localX, localY, layer.coords.w, layer.coords.h);
                } else {
                    // 1. Primary Lookup: Path ID (Fastest)
                    const directLayer = findLayerByPath(psd, layer.id);
                    let pixelSource: HTMLCanvasElement | null = null;

                    if (directLayer && directLayer.canvas) {
                        pixelSource = directLayer.canvas as HTMLCanvasElement;
                    } else {
                        // 2. Fallback Lookup: Recursive Name Search (Robustness for partial structure matches)
                        pixelSource = findPixelsRecursive(psd.children, layer.name);
                    }

                    if (pixelSource) {
                        // Normalization & Transform Application
                        ctx.globalAlpha = layer.opacity;
                        
                        // Move context to where the top-left of the layer should be
                        ctx.translate(layer.coords.x - originX, layer.coords.y - originY);
                        
                        if (layer.transform.rotation) {
                            // Rotate around center? No, standard CSS/Canvas transform usually assumes top-left unless offset.
                            // However, our data model usually stores top-left.
                            // For simple rotation, we rotate around the center of the object.
                            const cx = layer.coords.w / 2;
                            const cy = layer.coords.h / 2;
                            ctx.translate(cx, cy);
                            ctx.rotate((layer.transform.rotation * Math.PI) / 180);
                            ctx.translate(-cx, -cy);
                        }

                        // Draw at (0,0) relative to the translated context
                        ctx.drawImage(pixelSource, 0, 0, layer.coords.w, layer.coords.h);
                    } else {
                        // 3. Debug Wireframe (Missing Pixels)
                        const localX = layer.coords.x - originX;
                        const localY = layer.coords.y - originY;
                        
                        ctx.strokeStyle = '#fbbf24'; // Amber-400
                        ctx.lineWidth = 1;
                        ctx.setLineDash([2, 2]);
                        ctx.strokeRect(localX, localY, layer.coords.w, layer.coords.h);
                        
                        if (layer.coords.h > 12) {
                            ctx.fillStyle = '#fbbf24';
                            ctx.font = '9px monospace';
                            ctx.fillText(`[MISSING: ${layer.name.substring(0, 10)}]`, localX + 2, localY + 10);
                        }
                    }
                }

                ctx.restore();
            }
        };

        drawLayers(displayPayload.layers);

        const url = canvas.toDataURL('image/jpeg', 0.9);
        setLocalPreview(url);
        setRenderError(null);

    }, [displayPayload, psdRegistry, templateRegistry, globalVersion]);


    // Stats Calculation
    const dims = displayPayload?.metrics?.target || { w: 0, h: 0 };
    const scale = displayPayload?.scaleFactor || 1;

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
                    } ${!isProceduralAvailable ? 'opacity-30 cursor-not-allowed' : ''}`}
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
                    } ${!isPolishedAvailable ? 'opacity-30 cursor-not-allowed bg-slate-800' : ''}`}
                    title={!isPolishedAvailable ? "Audit Pending: No polished payload available yet" : "View Final CARO Output"}
                 >
                     {isPolishedAvailable ? <CheckCircle2 className="w-3 h-3" /> : <Lock className="w-3 h-3" />}
                     <span>Polished</span>
                 </button>
             </div>

             {/* Visualization Area */}
             <div className="relative w-full h-48 bg-[#0f172a] rounded border-2 border-dashed border-slate-600/50 overflow-hidden flex items-center justify-center shadow-inner group">
                 {/* Checkerboard Pattern (Only visible if image has transparency, but we use solid bg now) */}
                 <div className="absolute inset-0 opacity-5 pointer-events-none" 
                      style={{ backgroundImage: 'linear-gradient(45deg, #444 25%, transparent 25%), linear-gradient(-45deg, #444 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #444 75%), linear-gradient(-45deg, transparent 75%, #444 75%)', backgroundSize: '20px 20px', backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px' }} 
                 />

                 {!displayPayload && !renderError ? (
                     <div className="text-xs text-neutral-500 font-mono">Waiting for Payload...</div>
                 ) : renderError ? (
                     <div className="flex flex-col items-center justify-center text-red-400 p-4 text-center space-y-2">
                         <AlertTriangle className="w-6 h-6" />
                         <span className="text-[10px] font-mono">{renderError}</span>
                     </div>
                 ) : (
                     <div className="relative w-full h-full p-4 flex items-center justify-center">
                         {/* Composited Preview or Fallback */}
                         {localPreview ? (
                             <img src={localPreview} alt="Composited Preview" className="max-w-full max-h-full object-contain shadow-lg" />
                         ) : (
                             // Fallback if rendering takes time
                             <div className="flex flex-col items-center gap-1 text-neutral-500 animate-pulse">
                                <Zap className="w-4 h-4" />
                                <span className="text-[9px]">Synthesizing...</span>
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
  const { 
      payloadRegistry, 
      reviewerRegistry, 
      psdRegistry, 
      templateRegistry, 
      unregisterNode,
      globalVersion 
  } = useProceduralStore();

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, instanceCount, updateNodeInternals]);

  useEffect(() => {
    return () => unregisterNode(id);
  }, [id, unregisterNode]);

  const handleToggle = (index: number, mode: PreviewMode) => {
      setNodes((nds) => nds.map((n) => {
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
      setNodes((nds) => nds.map((n) => n.id === id ? { ...n, data: { ...n.data, instanceCount: instanceCount + 1 } } : n));
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
                  psdRegistry={psdRegistry}
                  templateRegistry={templateRegistry}
                  globalVersion={globalVersion}
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