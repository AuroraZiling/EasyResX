import { useEffect, useMemo, useState, useRef } from 'react';
import DataGrid from 'react-data-grid';
import type { Column, RenderEditCellProps, DataGridHandle } from 'react-data-grid';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ResxGroup, RowData } from '../types';
import { Plus, Search } from 'lucide-react';
import 'react-data-grid/lib/styles.css';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from './ui/dialog';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Label } from './ui/label';

interface ResourceGridProps {
    group: ResxGroup;
    isDark: boolean;
}

type HistoryAction = 
    | { type: 'update', key: string, lang: string, oldValue: string, newValue: string }
    | { type: 'rename', oldKey: string, newKey: string }
    | { type: 'add', key: string }
    | { type: 'delete', key: string, row: RowData };

function TextEditor({ row, column, onRowChange, onClose }: RenderEditCellProps<RowData>) {
    return (
        <input
            className="w-full h-full px-0 bg-background text-foreground outline-none"
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
    const [contextMenu, setContextMenu] = useState<{ x: number, y: number, row: RowData, columnKey: string } | null>(null);
    
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

    const handleUndo = async () => {
        if (history.length === 0) return;
        const action = history[history.length - 1];
        
        try {
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
                    await Promise.all(group.files.map(f => 
                        invoke('add_key', { path: f.path, key: action.key })
                    ));
                    // Restore values
                    for (const [lang, value] of Object.entries(action.row.values)) {
                        const file = group.files.find(f => f.lang === lang);
                        if (file && value) {
                            await invoke('update_resource', {
                                path: file.path,
                                key: action.key,
                                value: value
                            });
                        }
                    }
                    break;
                }
            }
            setHistory(prev => prev.slice(0, -1));
            // loadData(); // Triggered by watch
        } catch (e) {
            console.error("Undo failed", e);
            alert("Undo failed: " + e);
        }
    };

    // Keyboard shortcut for undo
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
                e.preventDefault();
                handleUndo();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [history, group]); 

    useEffect(() => {
        if (scrollToKey && gridRef.current) {
            const index = rows.findIndex(r => r.key === scrollToKey);
            if (index !== -1) {
                gridRef.current.scrollToCell({ rowIdx: index });
                setScrollToKey(null);
            }
        }
    }, [rows, scrollToKey]);

    const columns = useMemo<Column<RowData>[]>(() => {
        const langCols: Column<RowData>[] = group.files.map(file => ({
            key: `values.${file.lang}`,
            name: file.lang === 'default' ? 'Default' : file.lang,
            editable: true,
            width: 300,
            resizable: true,
            headerCellClass: 'pl-2',
            cellClass: 'pl-2',
            renderEditCell: TextEditor,
            renderCell: (props) => {
                const val = props.row.values[file.lang] || '';
                // Highlight search match
                if (filterText && val.toLowerCase().includes(filterText.toLowerCase())) {
                    return <span className="bg-yellow-200 dark:bg-yellow-900">{val}</span>;
                }
                return val;
            }
        }));

        return [
            { 
                key: 'key', 
                name: 'Key', 
                frozen: true, 
                width: 250, 
                resizable: true,
                editable: true,
                headerCellClass: 'pl-4',
                cellClass: 'pl-4',
                renderEditCell: TextEditor,
                renderCell: (props) => {
                    const val = props.row.key;
                    if (filterText && val.toLowerCase().includes(filterText.toLowerCase())) {
                        return <span className="bg-yellow-200 dark:bg-yellow-900">{val}</span>;
                    }
                    return val;
                }
            },
            ...langCols
        ];
    }, [group, filterText]);

    useEffect(() => {
        const handleClick = () => setContextMenu(null);
        document.addEventListener('click', handleClick);
        return () => document.removeEventListener('click', handleClick);
    }, []);

    useEffect(() => {
        loadData();
        invoke('watch_group', { directory: group.directory }).catch(console.error);

        const unlistenPromise = listen('resx-changed', () => {
            loadData();
        });

        return () => {
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
        if (columnKey === 'key') return; // Cannot clear key name, use rename or delete
        const lang = columnKey.replace('values.', '');
        const file = group.files.find(f => f.lang === lang);
        if (!file) return;

        const oldValue = row.values[lang] || '';
        if (!oldValue) return; // Nothing to clear

        try {
            await invoke('update_resource', {
                path: file.path,
                key: row.key,
                value: ""
            });
            pushHistory({ type: 'update', key: row.key, lang, oldValue, newValue: "" });
            // Optimistic update or wait for reload
            // loadData(); // will be triggered by watch
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
            await Promise.all(group.files.map(f => 
                 invoke('remove_key', { path: f.path, key: keyToDelete })
            ));
            pushHistory({ type: 'delete', key: keyToDelete, row: rowToDelete });
            setDeleteKeyDialogOpen(false);
            setKeyToDelete(null);
            // loadData(); // will be triggered by watch
        } catch (e) {
             console.error(e);
             alert("Failed to remove key: " + e);
        }
    }

    const handleRowsChange = async (newRows: RowData[], { indexes, column }: { indexes: number[], column: Column<RowData> }) => {
        // Optimistic update
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
            loadData(); // Revert
        }
    };

    // Filter rows
    const filteredRows = useMemo(() => {
        if (!filterText) return rows;
        const lower = filterText.toLowerCase();
        return rows.filter(r => 
            r.key.toLowerCase().includes(lower) || 
            Object.values(r.values).some(v => v.toLowerCase().includes(lower))
        );
    }, [rows, filterText]);

    return (
        <div className="flex-1 flex flex-col h-full bg-background overflow-hidden">
            <div className="bg-card p-4 border-b border-border flex items-center gap-4 flex-none">
                <Button size="icon" onClick={() => setAddKeyDialogOpen(true)}>
                    <Plus className="w-4 h-4" />
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
            <div className="flex-1 min-h-0 h-full overflow-y-auto relative">
                <DataGrid 
                    ref={gridRef}
                    className={isDark ? 'rdg-dark' : 'rdg-light'}
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
                            className="text-left px-2 py-1.5 text-sm hover:bg-destructive hover:text-destructive-foreground rounded-sm text-destructive"
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
