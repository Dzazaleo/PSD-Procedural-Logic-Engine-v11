import React, { memo, useState, useEffect, useMemo, useRef } from 'react';
import { Handle, Position, NodeProps, useEdges, useReactFlow } from 'reactflow';
import { PSDNodeData, TransformedPayload, TransformedLayer, TemplateMetadata } from '../types';
import { useProceduralStore } from '../store/ProceduralContext';
import { findLayerByPath } from '../services/psdService';
import { Eye, CheckCircle2, Zap, Scan, Layers, AlertTriangle } from 'lucide-react';

interface PreviewInstanceRowProps {
  nodeId: string;
  index: number;
  edges: any[];
}

// --- Helper: Deep Leaf Counter ---
const countDeepLeaves = (layers: TransformedLayer[]): number => {
    let count = 0;
    layers.forEach(l => {
        if (l.children) {
            count += countDeepLeaves(l.children);
        } else {
            count++;
        }
    });
    return count;
};

const PreviewInstanceRow: React.FC<PreviewInstanceRowProps> = ({ nodeId, index, edges }) => {
  const [viewMode, setViewMode] = useState<'PROCEDURAL' | 'POLISHED'>('PROCEDURAL');
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  
  // Store Access
  const { payloadRegistry, reviewerRegistry, psdRegistry, registerReviewerPayload, templateRegistry, globalVersion } = useProceduralStore();

  // 1. Resolve Inputs
  const inputEdge = edges.find(e => e.target === nodeId && e.targetHandle === `payload-in-${index}`);
  
  const polishedPayload = inputEdge && reviewerRegistry[inputEdge.source] 
    ? reviewerRegistry[inputEdge.source][inputEdge.sourceHandle || ''] 
    : undefined;

  const proceduralPayload = useMemo(() => {
    if (!polishedPayload && inputEdge && payloadRegistry[inputEdge.source]) {
        return payloadRegistry[inputEdge.source][inputEdge.sourceHandle || ''];
    }
    if (!polishedPayload) return undefined;
    
    // Fallback: Find matching procedural payload by container name
    const sourceId = polishedPayload.sourceNodeId;
    const registry = payloadRegistry[sourceId] || {};
    const allPayloads = Object.values(registry) as TransformedPayload[];
    return allPayloads.find(p => p.targetContainer === polishedPayload.targetContainer);
  }, [polishedPayload, payloadRegistry, inputEdge]);

  const isPolishedAvailable = !!polishedPayload && !!polishedPayload.isPolished;
  const effectiveMode = (viewMode === 'POLISHED' && isPolishedAvailable) ? 'POLISHED' : 'PROCEDURAL';
  const displayPayload = effectiveMode === 'POLISHED' ? polishedPayload : (polishedPayload || proceduralPayload);

  // 4. Broadcast Selection
  useEffect(() => {
    if (displayPayload) {
      registerReviewerPayload(nodeId, `preview-out-${index}`, displayPayload);
    }
  }, [displayPayload, nodeId, index, registerReviewerPayload]);

  // 5. "FINAL SIGN-OFF" COMPOSITOR
  useEffect(() => {
    if (!displayPayload) return;

    // BINARY RECOVERY LOGIC:
    // The payload.sourceNodeId often points to a Remapper/Reviewer which has no binary data.
    // We must find the original 'LoadPSD' source.
    // Strategy: Look up specific ID first, then fallback to scanning the registry for ANY valid PSD.
    let sourcePsd = psdRegistry[displayPayload.sourceNodeId];
    
    if (!sourcePsd) {
        const firstAvailableKey = Object.keys(psdRegistry)[0];
        if (firstAvailableKey) {
            sourcePsd = psdRegistry[firstAvailableKey];
            // console.log(`[Preview] Binary recovery: Used fallback ${firstAvailableKey} for pixels.`);
        }
    }

    const { w, h } = displayPayload.metrics.target;
    
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // A. Background (Dark Slate for Contrast)
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, w, h);

    // B. TARGET SPACE NORMALIZATION
    // The canvas represents the Target Container. 
    // We must subtract the Container's Global Origin from every Layer's Global Coordinate.
    let originX = 0;
    let originY = 0;
    let originFound = false;

    // Search all templates for this container definition
    const allTemplates = Object.values(templateRegistry) as TemplateMetadata[];
    for (const tmpl of allTemplates) {
        const container = tmpl.containers.find(c => 
            c.name.toLowerCase() === displayPayload.targetContainer.toLowerCase()
        );
        if (container) {
            originX = container.bounds.x;
            originY = container.bounds.y;
            originFound = true;
            break;
        }
    }

    // Fallback: If metadata is missing, Auto-Frame to the top-leftmost layer
    if (!originFound && displayPayload.layers.length > 0) {
        let minX = Infinity;
        let minY = Infinity;
        const scanLayers = (layers: TransformedLayer[]) => {
            layers.forEach(l => {
                if (l.isVisible) {
                    if (l.coords.x < minX) minX = l.coords.x;
                    if (l.coords.y < minY) minY = l.coords.y;
                    if (l.children) scanLayers(l.children);
                }
            });
        };
        scanLayers(displayPayload.layers);
        if (minX !== Infinity) {
            originX = minX;
            originY = minY;
        }
    }

    // C. DEEP RENDER TRAVERSAL
    const drawLayers = (layers: TransformedLayer[]) => {
        // Iterate BACKWARDS (length-1 to 0) to simulate Painter's Algorithm (Bottom Layers First)
        // Assumption: 'layers' array is ordered [Top ... Bottom] (Photoshop standard)
        for (let i = layers.length - 1; i >= 0; i--) {
            const layer = layers[i];
            
            if (layer.isVisible) {
                // If group, recurse immediately (don't draw the group folder itself)
                if (layer.children && layer.children.length > 0) {
                    drawLayers(layer.children);
                    continue; 
                }

                // --- Drawing Leaf Node ---
                // Calculate Local Coordinates relative to the Target Container
                const localX = layer.coords.x - originX;
                const localY = layer.coords.y - originY;

                ctx.save();
                
                // 1. Generative/Synthetic Placeholder
                if (layer.type === 'generative') {
                    ctx.fillStyle = 'rgba(192, 132, 252, 0.2)'; // Purple
                    ctx.strokeStyle = '#c084fc';
                    ctx.setLineDash([4, 4]);
                    ctx.fillRect(localX, localY, layer.coords.w, layer.coords.h);
                    ctx.strokeRect(localX, localY, layer.coords.w, layer.coords.h);
                } 
                // 2. Real Pixel Data
                else if (sourcePsd) {
                    const originalLayer = findLayerByPath(sourcePsd, layer.id);

                    if (originalLayer && originalLayer.canvas) {
                        ctx.globalAlpha = layer.opacity;
                        
                        // Apply Transforms
                        if (layer.transform.rotation) {
                             const cx = localX + layer.coords.w / 2;
                             const cy = localY + layer.coords.h / 2;
                             ctx.translate(cx, cy);
                             ctx.rotate((layer.transform.rotation * Math.PI) / 180);
                             ctx.translate(-cx, -cy);
                        }

                        try {
                            // Draw Image scaled to the Layer's Current Dimensions
                            // This preserves the Remapper's scaling logic visually
                            ctx.drawImage(
                                originalLayer.canvas, 
                                localX, 
                                localY, 
                                layer.coords.w, 
                                layer.coords.h
                            );
                        } catch (e) { /* Ignore canvas read errors */ }
                    } else {
                        // Binary Missing Indicator (Wireframe)
                        ctx.strokeStyle = '#ef4444'; // Red
                        ctx.lineWidth = 1;
                        ctx.strokeRect(localX, localY, layer.coords.w, layer.coords.h);
                    }
                }

                ctx.restore();
            }
        }
    };

    if (displayPayload.layers) {
        drawLayers(displayPayload.layers);
    }

    setLocalPreview(canvas.toDataURL('image/jpeg', 0.9));

  }, [displayPayload, psdRegistry, templateRegistry, globalVersion]);

  // Deep Count for UI
  const leafCount = useMemo(() => {
      if (!displayPayload?.layers) return 0;
      return countDeepLeaves(displayPayload.layers);
  }, [displayPayload]);

  return (
    <div className="relative border-b border-emerald-900/30 bg-slate-950/50 p-3 space-y-3">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
            <div className="flex items-center space-x-2">
                <div className={`w-2 h-2 rounded-full ${isPolishedAvailable ? 'bg-emerald-500' : 'bg-blue-500'}`}></div>
                <span className="text-[11px] font-bold text-slate-200 uppercase tracking-wider truncate max-w-[150px]">
                    {displayPayload?.targetContainer || `SLOT ${index}`}
                </span>
            </div>
            
            {/* Toggle */}
            <div className="flex bg-slate-900 rounded p-0.5 border border-slate-700">
                <button
                    onClick={() => setViewMode('PROCEDURAL')}
                    className={`px-3 py-1 rounded text-[9px] font-bold uppercase transition-all ${
                        effectiveMode === 'PROCEDURAL' 
                        ? 'bg-indigo-600 text-white shadow-sm' 
                        : 'text-slate-500 hover:text-slate-300'
                    }`}
                >
                    <Zap className="w-3 h-3 inline mr-1" />
                    Procedural
                </button>
                <button
                    onClick={() => setViewMode('POLISHED')}
                    disabled={!isPolishedAvailable}
                    className={`px-3 py-1 rounded text-[9px] font-bold uppercase transition-all ${
                        effectiveMode === 'POLISHED' 
                        ? 'bg-emerald-600 text-white shadow-sm' 
                        : 'text-slate-600 cursor-not-allowed opacity-50'
                    }`}
                >
                    <CheckCircle2 className="w-3 h-3 inline mr-1" />
                    Polished
                </button>
            </div>
        </div>

        {/* Canvas Stage */}
        <div className="relative w-full aspect-video bg-[#0f172a] rounded border border-slate-700/50 overflow-hidden flex items-center justify-center group">
            <div className="absolute inset-0 opacity-10 pointer-events-none" 
                 style={{ backgroundImage: 'radial-gradient(#334155 1px, transparent 1px)', backgroundSize: '10px 10px' }}>
            </div>

            {localPreview ? (
                <img 
                    src={localPreview} 
                    alt="Preview" 
                    className="max-w-full max-h-full object-contain shadow-2xl"
                />
            ) : (
                <div className="flex flex-col items-center text-slate-600 space-y-2">
                    <Eye className="w-6 h-6 opacity-50" />
                    <span className="text-[9px] uppercase tracking-widest opacity-50">Rendering...</span>
                </div>
            )}

            {/* Stats Overlay */}
            <div className="absolute bottom-2 right-2 flex gap-1">
                <div className="bg-black/60 backdrop-blur text-slate-300 text-[8px] px-1.5 py-0.5 rounded border border-white/10 font-mono">
                   {displayPayload ? `${displayPayload.metrics.target.w}x${displayPayload.metrics.target.h}` : 'N/A'}
                </div>
            </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-1">
            <div className="flex items-center space-x-2 text-[9px] text-slate-500 font-mono">
                <Layers className="w-3 h-3" />
                <span>{leafCount} Objects</span>
            </div>
            
            <div className="relative">
                <span className="text-[7px] text-emerald-600 font-bold tracking-widest uppercase mr-4">TO EXPORT</span>
                <Handle 
                    type="source" 
                    position={Position.Right} 
                    id={`preview-out-${index}`} 
                    className="!absolute !right-[-8px] !top-1/2 !-translate-y-1/2 !w-3 !h-3 !bg-emerald-400 !border-2 !border-slate-900 z-50" 
                />
            </div>
        </div>
        
        {/* Input Handle */}
        <Handle 
            type="target" 
            position={Position.Left} 
            id={`payload-in-${index}`} 
            className="!absolute !left-[-8px] !top-12 !w-3 !h-3 !bg-indigo-500 !border-2 !border-slate-900 z-50" 
        />
    </div>
  );
};

export const AssetPreviewNode = memo(({ id, data }: NodeProps<PSDNodeData>) => {
  const [instanceCount, setInstanceCount] = useState(data.instanceCount || 1);
  const { setNodes } = useReactFlow();
  const edges = useEdges();

  const addSlot = () => {
    const newCount = instanceCount + 1;
    setInstanceCount(newCount);
    setNodes(nds => nds.map(n => n.id === id ? { ...n, data: { ...n.data, instanceCount: newCount } } : n));
  };

  return (
    <div className="w-[420px] bg-slate-900 rounded-lg shadow-2xl border border-emerald-500/30 font-sans flex flex-col">
      <div className="bg-emerald-950/50 p-2 border-b border-emerald-500/20 flex items-center justify-between">
         <div className="flex items-center space-x-2">
           <Scan className="w-4 h-4 text-emerald-400" />
           <div className="flex flex-col leading-none">
             <span className="text-sm font-bold text-emerald-100">Asset Preview</span>
             <span className="text-[9px] text-emerald-500/60 font-mono uppercase">Visual Gatekeeper</span>
           </div>
         </div>
      </div>

      <div className="flex flex-col bg-slate-950">
         {Array.from({ length: instanceCount }).map((_, i) => (
             <PreviewInstanceRow key={i} nodeId={id} index={i} edges={edges} />
         ))}
      </div>

      <button 
        onClick={addSlot}
        className="w-full py-1.5 bg-slate-900 hover:bg-slate-800 border-t border-slate-800 text-slate-500 hover:text-slate-300 transition-colors flex items-center justify-center space-x-1"
      >
        <span className="text-[10px] font-bold uppercase tracking-widest">Add Preview Slot</span>
      </button>
    </div>
  );
});