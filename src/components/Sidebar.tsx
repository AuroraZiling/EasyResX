import React from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { ResxGroup } from '../types';
import { FolderOpen, Moon, Sun, X } from 'lucide-react';
import { Button } from './ui/button';

interface SidebarProps {
    groups: ResxGroup[];
    selectedGroup: ResxGroup | null;
    onSelectGroup: (group: ResxGroup) => void;
    setGroups: React.Dispatch<React.SetStateAction<ResxGroup[]>>;
    isDark: boolean;
    setIsDark: (isDark: boolean) => void;
    onRemoveGroup: (group: ResxGroup) => void;
}

export function Sidebar({ groups, selectedGroup, onSelectGroup, setGroups, isDark, setIsDark, onRemoveGroup }: SidebarProps) {
    async function handleOpenFolder() {
        const selected = await open({
            directory: true,
            multiple: false,
        });
        if (selected && typeof selected === 'string') {
            const result = await invoke<ResxGroup[]>('scan_directory', { path: selected });
            // Append new groups, avoiding duplicates by directory
            setGroups(prev => {
                const existingDirs = new Set(prev.map(g => g.directory));
                const newGroups = result.filter(g => !existingDirs.has(g.directory));
                return [...prev, ...newGroups];
            });
        }
    }

    return (
        <div className="w-64 h-full bg-muted/30 flex flex-col border-r border-border">
            <div className="p-4 border-b border-border">
                <div className="flex items-center gap-2">
                    <button
                        onClick={handleOpenFolder}
                        className="flex-1 flex items-center justify-center gap-2 bg-primary hover:bg-primary/90 text-primary-foreground px-4 py-2 rounded-md transition-colors text-sm font-medium"
                    >
                        <FolderOpen className="w-4 h-4" />
                        Open Folder
                    </button>
                    <button 
                        onClick={() => setIsDark(!isDark)}
                        className="p-2 rounded-md border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors"
                        title={isDark ? "Switch to Light Mode" : "Switch to Dark Mode"}
                    >
                        {isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
                    </button>
                </div>
            </div>
            <div className="flex-1 overflow-y-auto">
                {groups.map((group) => (
                    <div
                        key={group.name + group.directory}
                        onClick={() => onSelectGroup(group)}
                        className={`p-3 cursor-pointer hover:bg-accent hover:text-accent-foreground transition-colors group relative ${
                            selectedGroup?.name === group.name && selectedGroup?.directory === group.directory ? 'bg-accent text-accent-foreground border-l-4 border-primary' : 'text-muted-foreground'
                        }`}
                    >
                        <div className="font-medium text-foreground pr-6">{group.name}</div>
                        <div className="text-xs opacity-70 mt-1 truncate" title={group.directory}>{group.directory}</div>
                        <div className="text-xs opacity-50 mt-0.5">{group.files.length} files</div>
                        
                        <Button
                            variant="ghost"
                            size="icon"
                            className="absolute right-1 top-1 h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
                            onClick={(e) => {
                                e.stopPropagation();
                                onRemoveGroup(group);
                            }}
                        >
                            <X className="h-3 w-3" />
                        </Button>
                    </div>
                ))}
                {groups.length === 0 && (
                    <div className="p-4 text-center text-gray-500 text-sm">
                        No groups found. Open a folder containing .resx files.
                    </div>
                )}
            </div>
        </div>
    );
}
