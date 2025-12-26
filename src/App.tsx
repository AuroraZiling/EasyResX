import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Sidebar } from "./components/Sidebar";
import { ResourceGrid } from "./components/ResourceGrid";
import { ResxGroup } from "./types";
import "./App.css";

interface SavedGroup {
    name: string;
    directory: string;
}

interface AppSettings {
    saved_groups: SavedGroup[];
    theme: string;
}

function App() {
  const [groups, setGroups] = useState<ResxGroup[]>([]);
  const [selectedGroup, setSelectedGroup] = useState<ResxGroup | null>(null);
  const [isDark, setIsDark] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  // Load settings on startup
  useEffect(() => {
      async function loadSettings() {
          try {
              const settings = await invoke<AppSettings>('get_app_settings');
              setIsDark(settings.theme === 'dark');
              
              if (settings.saved_groups && settings.saved_groups.length > 0) {
                  const uniqueDirs = Array.from(new Set(settings.saved_groups.map(g => g.directory)));
                  const allGroups: ResxGroup[] = [];
                  
                  for (const path of uniqueDirs) {
                      try {
                          const result = await invoke<ResxGroup[]>('scan_directory', { path });
                          // Filter to only keep saved groups
                          const savedInThisDir = settings.saved_groups.filter(g => g.directory === path);
                          const keptGroups = result.filter(r => 
                              savedInThisDir.some(s => s.name === r.name)
                          );
                          allGroups.push(...keptGroups);
                      } catch (e) {
                          console.error(`Failed to load path ${path}:`, e);
                      }
                  }
                  setGroups(allGroups);
              }
          } catch (e) {
              console.error("Failed to load settings:", e);
          } finally {
              setSettingsLoaded(true);
          }
      }
      loadSettings();
  }, []);

  // Save settings whenever relevant state changes
  useEffect(() => {
      if (!settingsLoaded) return;

      const settings: AppSettings = {
          saved_groups: groups.map(g => ({ name: g.name, directory: g.directory })),
          theme: isDark ? 'dark' : 'light'
      };

      invoke('save_app_settings', { settings }).catch(console.error);
  }, [groups, isDark, settingsLoaded]);

  useEffect(() => {
      if (isDark) {
          document.documentElement.classList.add('dark');
      } else {
          document.documentElement.classList.remove('dark');
      }
  }, [isDark]);

  const handleRemoveGroup = (groupToRemove: ResxGroup) => {
      setGroups(prev => prev.filter(g => g !== groupToRemove));
      if (selectedGroup === groupToRemove) {
          setSelectedGroup(null);
      }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      <Sidebar 
        groups={groups} 
        selectedGroup={selectedGroup} 
        onSelectGroup={setSelectedGroup} 
        setGroups={setGroups}
        isDark={isDark}
        setIsDark={setIsDark}
        onRemoveGroup={handleRemoveGroup}
      />
      
      {selectedGroup ? (
        <ResourceGrid group={selectedGroup} isDark={isDark} />
      ) : (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <h2 className="text-2xl font-semibold mb-2 text-foreground">Welcome</h2>
            <p>Select or open a folder to manage your .resx resources.</p>
          </div>
        </div>
      )}
    </div>
  );
}

export default App;