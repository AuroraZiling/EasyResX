export interface ResxFile {
    path: string;
    lang: string;
}

export interface ResxGroup {
    name: string;
    directory: string;
    files: ResxFile[];
}

export interface RowData {
    key: string;
    values: Record<string, string>; // lang -> value
}
