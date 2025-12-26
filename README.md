# EasyResX

> [!WARNING]
> **Vibe Coding**
>
> This project is a result of "vibe coding". It is currently in an experimental state and is **not recommended for critical production use**. Features may change, and bugs may exist. The implementation reflects a learning process with the Tauri framework.

EasyResX is a desktop application designed to assist with editing .NET `.resx` resource files. Built with Tauri, React, and Rust, it provides a modern interface for managing internationalization (i18n) strings in your projects.

Designed primarily for Windows, but built on cross-platform technologies (macOS/Linux support is untested).

![EasyResX Screenshot](./public/easyresx.webp)

## Tech Stack

- **Frontend**: [React](https://react.dev/), [TypeScript](https://www.typescriptlang.org/), [Tailwind CSS](https://tailwindcss.com/), [Radix UI](https://www.radix-ui.com/)
- **Backend**: [Tauri](https://tauri.app/)

## Prerequisites

If you want to build or run this from source:

- [Node.js](https://nodejs.org/) (v16 or later)
- [pnpm](https://pnpm.io/)
- [Rust](https://www.rust-lang.org/tools/install)
- [Visual Studio C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) (for Windows)

## Getting Started

1.  **Clone the repository**

    ```bash
    git clone https://github.com/yourusername/EasyResX.git
    cd EasyResX
    ```

2.  **Install dependencies**

    ```bash
    pnpm install
    ```

3.  **Run in development mode**

    ```bash
    pnpm tauri dev
    ```

## Building

To build the application:

```bash
pnpm tauri build
```

## Usage

1.  Launch the application.
2.  Use the **"Open Folder"** button to select a directory containing `.resx` files.
3.  Select a group from the sidebar to view resources.
4.  Edit values in the grid. (Backup your files before editing is recommended).

## License

[MIT](LICENSE)