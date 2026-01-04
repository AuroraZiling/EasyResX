import { useEffect, useMemo, useState, useRef } from 'react';
import DataGrid from 'react-data-grid';
import type { Column, RenderEditCellProps, DataGridHandle } from 'react-data-grid';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ask } from '@tauri-apps/plugin-dialog';
import { ResxGroup, RowData } from '../types';
import { Plus, Search, Filter } from 'lucide-react';
import 'react-data-grid/lib/styles.css';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';
import { cn } from '../lib/utils';

interface ResourceGridProps {
    group: ResxGroup;
    isDark: boolean;
}

type HistoryAction = 
    | { type: 'update', key: string, lang: string, oldValue: string, newValue: string }
    | { type: 'rename', oldKey: string, newKey: string }
    | { type: 'add', key: string }
    | { type: 'delete', key: string, row: RowData, indices?: Record<string, number> }
    | { type: 'batch', actions: HistoryAction[] };

interface Point {
    rowIdx: number;
    colIdx: number;
}

function TextEditor({ row, column, onRowChange, onClose }: RenderEditCellProps<RowData>) {
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (inputRef.current) {
            requestAnimationFrame(() => {
                inputRef.current?.select();
            });
        }
    }, []);

    return (
        <input
            ref={inputRef}
            className="w-full h-full px-4 bg-background text-foreground outline-none"
            autoFocus
            value={column.key === 'key' ? row.key : row.values[column.key.replace('values.', '')] || ''}
            onChange={(e) => {
                if (column.key === 'key') {
                    onRowChange({ ...row, key: e.target.value });
                } else {
                    const lang = column.key.replace('values.', '');
                    onRowChange({ ...row, values: { ...row.values, [lang]: e.target.value } });
                }
            }}
            onBlur={() => onClose(true)}
        />
    );
}

export function ResourceGrid({ group, isDark }: ResourceGridProps) {
    const [rows, setRows] = useState<RowData[]>([]);
    const [filterText, setFilterText] = useState('');
    const [showEmptyOnly, setShowEmptyOnly] = useState(false);
    const [contextMenu, setContextMenu] = useState<{ x: number, y: number, row: RowData, columnKey: string } | null>(null);
    
    // Custom Selection State
    const [selectionAnchor, setSelectionAnchor] = useState<Point | null>(null);
    const [selectionCurrent, setSelectionCurrent] = useState<Point | null>(null);
    const isMouseDown = useRef(false);

    const gridRef = useRef<DataGridHandle>(null);
    const [scrollToKey, setScrollToKey] = useState<string | null>(null);
    
    const [addKeyDialogOpen, setAddKeyDialogOpen] = useState(false);
    const [newKeyName, setNewKeyName] = useState('');
    
    const [deleteKeyDialogOpen, setDeleteKeyDialogOpen] = useState(false);
    const [keyToDelete, setKeyToDelete] = useState<string | null>(null);

    const [history, setHistory] = useState<HistoryAction[]>([]);
    
    const pushHistory = (action: HistoryAction) => {
        setHistory(prev => [...prev, action]);
    };

    const performUndoAction = async (action: HistoryAction) => {
        switch (action.type) {
            case 'update': {
                const file = group.files.find(f => f.lang === action.lang);
                if (file) {
                    await invoke('update_resource', {
                        path: file.path,
                        key: action.key,
                        value: action.oldValue
                    });
                }
                break;
            }
            case 'rename': {
                await Promise.all(group.files.map(f => 
                    invoke('rename_key', { path: f.path, old_key: action.newKey, new_key: action.oldKey })
                ));
                break;
            }
            case 'add': {
                await Promise.all(group.files.map(f => 
                    invoke('remove_key', { path: f.path, key: action.key })
                ));
                break;
            }
            case 'delete': {
                // Restore key and values
                await Promise.all(group.files.map(f => {
                    const index = action.indices && action.indices[f.path] !== undefined ? action.indices[f.path] : 0;
                    const value = action.row.values[f.lang] || "";
                    return invoke('insert_key', { path: f.path, key: action.key, value, index });
                }));
                break;
            }
            case 'batch': {
                // Check if we can optimize consecutive delete undos (which become inserts)
                const deleteActions = action.actions.filter(a => a.type === 'delete');
                const updateActions = action.actions.filter(a => a.type === 'update');

                if (deleteActions.length > 0 && deleteActions.length === action.actions.length) {
                    // Optimized batch insert
                    const toastId = toast.loading(`Restoring ${deleteActions.length} keys...`);
                    try {
                        const insertsByFile = new Map<string, {key: string, value: string, index: number}[]>();
                        
                        // We need to restore ALL delete actions.
                        // Each delete action corresponds to a key.
                        // Ideally we have the index it was at.
                        // For a key, we might have multiple files.
                        
                        for (const act of deleteActions) {
                            if (act.type !== 'delete') continue;
                            
                            // For each file in the group, we need to know the index and value
                            // The 'delete' action stored 'indices' map: path -> index
                            // And 'row' data: row.values[lang]
                            
                            for (const file of group.files) {
                                if (!insertsByFile.has(file.path)) {
                                    insertsByFile.set(file.path, []);
                                }
                                
                                const val = act.row.values[file.lang] || "";
                                // If indices are missing (legacy or single delete), default to 0 or end?
                                // If we assume batch delete was used, indices should be present.
                                const idx = act.indices ? act.indices[file.path] : 0;
                                
                                insertsByFile.get(file.path)!.push({
                                    key: act.key,
                                    value: val,
                                    index: idx !== undefined ? idx : 0
                                });
                            }
                        }
                        
                        await Promise.all(Array.from(insertsByFile.entries()).map(([path, items]) => 
                            invoke('batch_insert_keys', { path, items })
                        ));
                        
                        toast.success(`Restored ${deleteActions.length} keys`, { id: toastId });
                    } catch (e) {
                         console.error("Batch undo failed", e);
                         toast.error("Batch undo failed: " + e, { id: toastId });
                         // Fallback?
                    }
                } else if (updateActions.length > 0 && updateActions.length === action.actions.length) {
                    // Optimized batch update (for clearing/pasting cells)
                    const toastId = toast.loading(`Restoring ${updateActions.length} values...`);
                    try {
                        const updatesByPath = new Map<string, Record<string, string>>();
                        
                        for (const act of updateActions) {
                             if (act.type !== 'update') continue;
                             const file = group.files.find(f => f.lang === act.lang);
                             if (file) {
                                 if (!updatesByPath.has(file.path)) updatesByPath.set(file.path, {});
                                 updatesByPath.get(file.path)![act.key] = act.oldValue;
                             }
                        }

                        await Promise.all(Array.from(updatesByPath.entries()).map(([path, updates]) => 
                            invoke('batch_update_resources', { path, updates })
                        ));
                         
                        toast.success(`Restored ${updateActions.length} values`, { id: toastId });
                    } catch (e) {
                        console.error("Batch undo failed", e);
                        toast.error("Batch undo failed: " + e, { id: toastId });
                    }
                } else {
                    // Fallback to sequential undo for mixed actions or non-delete batches
                    for (let i = action.actions.length - 1; i >= 0; i--) {
                        await performUndoAction(action.actions[i]);
                    }
                }
                break;
            }
        }
    };

    const handleUndo = async () => {
        if (history.length === 0) return;
        const action = history[history.length - 1];
        
        try {
            await performUndoAction(action);
            setHistory(prev => prev.slice(0, -1));
        } catch (e) {
            console.error("Undo failed", e);
            alert("Undo failed: " + e);
        }
    };

    useEffect(() => {
        const handleKeyDown = async (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
                e.preventDefault();
                handleUndo();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [history, group]); 

    useEffect(() => {
        const handleGlobalMouseUp = () => {
            isMouseDown.current = false;
        };
        window.addEventListener('mouseup', handleGlobalMouseUp);
        return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
    }, []);

    useEffect(() => {
        if (scrollToKey && gridRef.current) {
            const index = rows.findIndex(r => r.key === scrollToKey);
            if (index !== -1) {
                gridRef.current.scrollToCell({ rowIdx: index });
                setScrollToKey(null);
            }
        }
    }, [rows, scrollToKey]);

    // Derived Selection Range
    const selectionRange = useMemo(() => {
        if (!selectionAnchor || !selectionCurrent) return null;
        return {
            startRow: Math.min(selectionAnchor.rowIdx, selectionCurrent.rowIdx),
            endRow: Math.max(selectionAnchor.rowIdx, selectionCurrent.rowIdx),
            startCol: Math.min(selectionAnchor.colIdx, selectionCurrent.colIdx),
            endCol: Math.max(selectionAnchor.colIdx, selectionCurrent.colIdx),
        };
    }, [selectionAnchor, selectionCurrent]);

    const isCellSelected = (rowIdx: number, colIdx: number) => {
        if (!selectionRange) return false;
        return rowIdx >= selectionRange.startRow && rowIdx <= selectionRange.endRow &&
               colIdx >= selectionRange.startCol && colIdx <= selectionRange.endCol;
    };

    const filteredRows = useMemo(() => {
        let result = rows;

        if (showEmptyOnly) {
            result = result.filter(r => 
                group.files.some(f => {
                    const val = r.values[f.lang];
                    return !val || !val.trim();
                })
            );
        }

        if (filterText) {
            const lower = filterText.toLowerCase();
            result = result.filter(r => 
                r.key.toLowerCase().includes(lower) || 
                Object.values(r.values).some(v => v.toLowerCase().includes(lower))
            );
        }

        return result;
    }, [rows, filterText, showEmptyOnly, group]);

    const columns = useMemo<Column<RowData>[]>(() => {
        const langCols: Column<RowData>[] = group.files.map((file, i) => {
            const colIdx = i + 1; // 0 is key
            return {
                key: `values.${file.lang}`,
                name: file.lang === 'default' ? 'Default' : file.lang,
                editable: true,
                width: 300,
                resizable: true,
                headerCellClass: 'pl-4',
                // Remove padding here, add in renderCell
                cellClass: (row) => {
                    const val = row.values[file.lang] || '';
                    return cn("select-none p-0", !val.trim() && 'bg-yellow-100/50 dark:bg-yellow-500/20');
                },
                renderEditCell: (props) => <TextEditor {...props} />,
                renderCell: (props) => {
                    const rowIdx = props.rowIdx ?? filteredRows.indexOf(props.row);
                    const isSelected = isCellSelected(rowIdx, colIdx);
                    const val = props.row.values[file.lang] || '';
                    
                    return (
                        <div 
                            className={cn(
                                "w-full h-full pl-4 flex items-center border-2 border-transparent", 
                                isSelected && "bg-blue-500/20 border-blue-500"
                            )}
                            onMouseDown={(e) => {
                                if (e.buttons === 1) { // Left click
                                    isMouseDown.current = true;
                                    const pt = { rowIdx, colIdx };
                                    setSelectionAnchor(pt);
                                    setSelectionCurrent(pt);
                                }
                            }}
                            onMouseEnter={() => {
                                if (isMouseDown.current) {
                                    setSelectionCurrent({ rowIdx, colIdx });
                                }
                            }}
                        >
                            {filterText && val.toLowerCase().includes(filterText.toLowerCase()) ? (
                                <span className="bg-yellow-200 dark:bg-yellow-900 pointer-events-none">{val}</span>
                            ) : (
                                <span className="pointer-events-none">{val}</span>
                            )}
                        </div>
                    );
                }
            };
        });

        const keyCol: Column<RowData> = { 
            key: 'key', 
            name: 'Key', 
            frozen: true, 
            width: 250, 
            resizable: true,
            editable: true,
            headerCellClass: 'pl-4',
            cellClass: 'select-none p-0',
            renderEditCell: (props) => <TextEditor {...props} />,
            renderCell: (props) => {
                const rowIdx = props.rowIdx ?? filteredRows.indexOf(props.row);
                const colIdx = 0;
                const isSelected = isCellSelected(rowIdx, colIdx);
                const val = props.row.key;

                return (
                    <div 
                        className={cn(
                            "w-full h-full pl-4 flex items-center border-2 border-transparent", 
                            isSelected && "bg-blue-500/20 border-blue-500"
                        )}
                        onMouseDown={(e) => {
                            if (e.buttons === 1) {
                                isMouseDown.current = true;
                                const pt = { rowIdx, colIdx };
                                setSelectionAnchor(pt);
                                setSelectionCurrent(pt);
                            }
                        }}
                        onMouseEnter={() => {
                            if (isMouseDown.current) {
                                setSelectionCurrent({ rowIdx, colIdx });
                            }
                        }}
                    >
                         {filterText && val.toLowerCase().includes(filterText.toLowerCase()) ? (
                            <span className="bg-yellow-200 dark:bg-yellow-900 pointer-events-none">{val}</span>
                        ) : (
                            <span className="pointer-events-none">{val}</span>
                        )}
                    </div>
                );
            }
        };

        return [keyCol, ...langCols];
    }, [group, filterText, selectionRange, filteredRows]); // Re-render when selection changes

    useEffect(() => {
        const handleClick = () => setContextMenu(null);
        document.addEventListener('click', handleClick);
        return () => document.removeEventListener('click', handleClick);
    }, []);

    useEffect(() => {
        loadData();
        invoke('watch_group', { directory: group.directory }).catch(console.error);

        let debounceTimer: number | undefined;

        const unlistenPromise = listen('resx-changed', () => {
            if (debounceTimer) {
                clearTimeout(debounceTimer);
            }
            debounceTimer = window.setTimeout(() => {
                console.log("Reloading data due to external change...");
                loadData();
                debounceTimer = undefined;
            }, 500);
        });

        return () => {
            if (debounceTimer) clearTimeout(debounceTimer);
            unlistenPromise.then(unlisten => unlisten());
        };
    }, [group]);

    async function loadData() {
        try {
            const data = await invoke<RowData[]>('load_group', { files: group.files });
            data.sort((a, b) => a.key.localeCompare(b.key));
            setRows(data);
        } catch (e) {
            console.error(e);
        }
    }

    async function handleAddKey() {
        if (!newKeyName) return;
        
        try {
            await Promise.all(group.files.map(f => 
                 invoke('add_key', { path: f.path, key: newKeyName })
            ));
            pushHistory({ type: 'add', key: newKeyName });
            setNewKeyName('');
            setAddKeyDialogOpen(false);
            setScrollToKey(newKeyName);
            await loadData();
        } catch (e) {
             console.error(e);
             alert("Failed to add key: " + e);
        }
    }

    async function handleClearCell(row: RowData, columnKey: string) {
        if (columnKey === 'key') return; 
        const lang = columnKey.replace('values.', '');
        const file = group.files.find(f => f.lang === lang);
        if (!file) return;

        const oldValue = row.values[lang] || '';
        if (!oldValue) return; 

        try {
            await invoke('update_resource', {
                path: file.path,
                key: row.key,
                value: ""
            });
            pushHistory({ type: 'update', key: row.key, lang, oldValue, newValue: "" });
        } catch (e) {
            console.error(e);
            alert("Failed to clear cell: " + e);
        }
    }

    async function handleDeleteKey() {
        if (!keyToDelete) return;
        
        const rowToDelete = rows.find(r => r.key === keyToDelete);
        if (!rowToDelete) return;

         try {
            const indices: Record<string, number> = {};
            await Promise.all(group.files.map(async f => {
                 const index = await invoke<number>('remove_key', { path: f.path, key: keyToDelete });
                 indices[f.path] = index;
            }));
            pushHistory({ type: 'delete', key: keyToDelete, row: rowToDelete, indices });
            setDeleteKeyDialogOpen(false);
            setKeyToDelete(null);
        } catch (e) {
             console.error(e);
             alert("Failed to remove key: " + e);
        }
    }

    const handleGridKeyDown = async (event: React.KeyboardEvent<HTMLDivElement>) => {
        if (event.key === 'Delete' || event.key === 'Backspace') {
            if (!selectionRange) return;

            const rowsToDeleteIndex = new Set<number>();
            const cellsToClear: { rowIdx: number, lang: string, oldValue: string, key: string }[] = [];
            const visitedCells = new Set<string>();
            
            // Map visual columns to data columns
            // columns array is rebuilt on render, but indices match the loop in useMemo
            // 0 is key, 1..N are langs
            
            for (let c = selectionRange.startCol; c <= selectionRange.endCol; c++) {
                const col = columns[c];
                if (!col) continue;

                if (col.key === 'key') {
                    for (let r = selectionRange.startRow; r <= selectionRange.endRow; r++) {
                        rowsToDeleteIndex.add(r);
                    }
                } else {
                    const lang = col.key.replace('values.', '');
                    for (let r = selectionRange.startRow; r <= selectionRange.endRow; r++) {
                         const cellId = `${r}:${lang}`;
                         if (!visitedCells.has(cellId)) {
                             const row = filteredRows[r];
                             if (row) {
                                 visitedCells.add(cellId);
                                 cellsToClear.push({ 
                                     rowIdx: r, 
                                     lang, 
                                     oldValue: row.values[lang] || '', 
                                     key: row.key 
                                 });
                             }
                         }
                    }
                }
            }

            if (rowsToDeleteIndex.size > 0) {
                const sortedIndices = Array.from(rowsToDeleteIndex).sort((a, b) => a - b);
                const rowsToDelete = sortedIndices.map(i => filteredRows[i]);
                const keys = rowsToDelete.map(r => r.key);

                const confirmed = await ask(`Are you sure you want to delete ${keys.length} keys?\n\n${keys.slice(0, 10).join('\n')}${keys.length > 10 ? '\n...' : ''}`, {
                    title: 'Batch Delete Keys',
                    kind: 'warning',
                });

                if (confirmed) {
                    const batchActions: HistoryAction[] = [];
                    const toastId = toast.loading(`Deleting ${keys.length} keys...`);
                    try {
                        const indicesByKey: Record<string, Record<string, number>> = {}; // key -> { path: index }

                        await Promise.all(group.files.map(async f => {
                             const result = await invoke<Record<string, number>>('batch_remove_keys', { 
                                 path: f.path, 
                                 keys: keys 
                             });
                             // result is key -> index
                             for (const [key, index] of Object.entries(result)) {
                                 if (!indicesByKey[key]) indicesByKey[key] = {};
                                 indicesByKey[key][f.path] = index;
                             }
                        }));
                        
                        for (const row of rowsToDelete) {
                             batchActions.push({ 
                                 type: 'delete', 
                                 key: row.key, 
                                 row,
                                 indices: indicesByKey[row.key]
                             });
                        }

                        pushHistory({ type: 'batch', actions: batchActions });
                        setSelectionAnchor(null);
                        setSelectionCurrent(null);
                        toast.success(`Deleted ${keys.length} keys`, { id: toastId });
                    } catch (e) {
                        console.error("Batch delete failed", e);
                        toast.error("Batch delete failed: " + e, { id: toastId });
                    }
                }
            } else if (cellsToClear.length > 0) {
                const toClear = cellsToClear.filter(c => c.oldValue !== '');
                if (toClear.length === 0) return;

                const confirmed = await ask(`Are you sure you want to clear ${toClear.length} cells?`, {
                    title: 'Batch Clear Values',
                    kind: 'warning',
                });

                if (confirmed) {
                     const batchActions: HistoryAction[] = [];
                     const toastId = toast.loading(`Clearing ${toClear.length} cells...`);
                     try {
                         const updatesByFile = new Map<string, Record<string, string>>();
                         
                         for (const item of toClear) {
                             const file = group.files.find(f => f.lang === item.lang);
                             if (file) {
                                 if (!updatesByFile.has(file.path)) {
                                     updatesByFile.set(file.path, {});
                                 }
                                 updatesByFile.get(file.path)![item.key] = "";
                                 
                                 batchActions.push({ 
                                     type: 'update', 
                                     key: item.key, 
                                     lang: item.lang, 
                                     oldValue: item.oldValue, 
                                     newValue: "" 
                                 });
                             }
                         }

                         await Promise.all(Array.from(updatesByFile.entries()).map(([path, updates]) => 
                             invoke('batch_update_resources', { path, updates })
                         ));
                         
                         pushHistory({ type: 'batch', actions: batchActions });
                         toast.success(`Cleared ${toClear.length} cells`, { id: toastId });
                     } catch (e) {
                         console.error("Batch clear failed", e);
                         toast.error("Batch clear failed: " + e, { id: toastId });
                     }
                }
            }
        }
    };

    const handleRowsChange = async (newRows: RowData[], { indexes, column }: { indexes: number[], column: Column<RowData> }) => {
        const updatedRow = newRows[indexes[0]];
        const oldRow = rows[indexes[0]];
        
        if (!updatedRow) return;

        setRows(newRows);

        try {
            if (column.key === 'key') {
                if (updatedRow.key !== oldRow.key) {
                     await Promise.all(group.files.map(f => 
                        invoke('rename_key', { path: f.path, old_key: oldRow.key, new_key: updatedRow.key })
                    ));
                    pushHistory({ type: 'rename', oldKey: oldRow.key, newKey: updatedRow.key });
                }
            } else {
                const lang = column.key.replace('values.', '');
                const newValue = updatedRow.values[lang] || '';
                const oldValue = oldRow.values[lang] || '';
                
                if (newValue !== oldValue) {
                    const file = group.files.find(f => f.lang === lang);
                    if (file) {
                        await invoke('update_resource', {
                            path: file.path,
                            key: updatedRow.key,
                            value: newValue
                        });
                        pushHistory({ type: 'update', key: updatedRow.key, lang, oldValue, newValue });
                    }
                }
            }
        } catch (e) {
            console.error("Update failed", e);
            alert("Update failed: " + e);
            loadData(); 
        }
    };

    return (
        <div className="flex-1 flex flex-col h-full bg-background overflow-hidden">
            <div className="bg-card p-4 border-b border-border flex items-center gap-4 flex-none">
                <Button size="icon" onClick={() => setAddKeyDialogOpen(true)} title="Add New Key">
                    <Plus className="w-4 h-4" />
                </Button>
                <Button 
                    variant={showEmptyOnly ? "default" : "outline"}
                    size="icon" 
                    onClick={() => setShowEmptyOnly(!showEmptyOnly)}
                    title={showEmptyOnly ? "Show All Rows" : "Show Rows with Empty Cells"}
                >
                    <Filter className="w-4 h-4" />
                </Button>
                <div className="flex-1 relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <input 
                        type="text" 
                        placeholder="Search keys and values..." 
                        className="pl-10 pr-4 py-2 w-full border border-input rounded-md bg-background text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        value={filterText}
                        onChange={e => setFilterText(e.target.value)}
                    />
                </div>
            </div>
            <div 
                className="flex-1 min-h-0 h-full overflow-y-auto relative select-none"
                onKeyDown={handleGridKeyDown}
            >
                <DataGrid 
                    ref={gridRef}
                    className={isDark ? 'rdg-dark h-full' : 'rdg-light h-full'}
                    columns={columns} 
                    rows={filteredRows} 
                    rowKeyGetter={r => r.key}
                    onRowsChange={handleRowsChange}
                    style={{ blockSize: '100%' }}
                    rowHeight={30}
                    onCellContextMenu={({ row, column }, event) => {
                        event.preventDefault();
                        setContextMenu({
                            x: event.clientX,
                            y: event.clientY,
                            row,
                            columnKey: column.key
                        });
                    }}
                />
                {contextMenu && (
                    <div 
                        style={{ top: contextMenu.y, left: contextMenu.x }} 
                        className="fixed z-50 bg-popover text-popover-foreground border border-border rounded-md shadow-md p-1 min-w-[150px] flex flex-col"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <button 
                            onClick={() => {
                                handleClearCell(contextMenu.row, contextMenu.columnKey);
                                setContextMenu(null);
                            }} 
                            className="text-left px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground rounded-sm"
                        >
                            Clear Value
                        </button>
                        <button 
                            onClick={() => {
                                setKeyToDelete(contextMenu.row.key);
                                setDeleteKeyDialogOpen(true);
                                setContextMenu(null);
                            }} 
                            className="text-left px-2 py-1.5 text-sm hover:bg-destructive hover:text-destructive-foreground rounded-sm text-red-500 dark:text-red-400"
                        >
                            Delete Key
                        </button>
                    </div>
                )}
            </div>

            <Dialog open={addKeyDialogOpen} onOpenChange={setAddKeyDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Add New Key</DialogTitle>
                        <DialogDescription>
                            Enter the name for the new resource key.
                        </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-4 py-4">
                        <div className="grid grid-cols-4 items-center gap-4">
                            <Label htmlFor="key-name" className="text-right">
                                Key Name
                            </Label>
                            <Input
                                id="key-name"
                                value={newKeyName}
                                onChange={(e) => setNewKeyName(e.target.value)}
                                className="col-span-3"
                                autoFocus
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        handleAddKey();
                                    }
                                }}
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setAddKeyDialogOpen(false)}>Cancel</Button>
                        <Button onClick={handleAddKey}>Add Key</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            <Dialog open={deleteKeyDialogOpen} onOpenChange={setDeleteKeyDialogOpen}>
                <DialogContent>
                    <DialogHeader>
                        <DialogTitle>Delete Key</DialogTitle>
                        <DialogDescription>
                            Are you sure you want to delete the key "{keyToDelete}"? This action cannot be undone.
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setDeleteKeyDialogOpen(false)}>Cancel</Button>
                        <Button variant="destructive" onClick={handleDeleteKey}>Delete</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    );
}
