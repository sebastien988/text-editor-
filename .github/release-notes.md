A fast, dependency-free text editor that runs in the browser. Works on Windows, macOS, and Linux — pick whichever download suits you.

### `featherpad.html` — one file, nothing to install

Download it and double-click. That's the whole process. It runs offline, on any OS with a modern browser, and never touches the network. Everything is inlined into the single file, including the search worker, so search still runs off the main thread.

Best if you just want the editor and don't care where it lives.

### `featherpad-<version>.zip` / `.tar.gz` — the full app

Unpack it and run the launcher for your system:

| OS | Run |
|---|---|
| Windows | double-click `start.bat` |
| macOS / Linux | `./start.sh` |

Both serve the folder on `http://localhost:8080` and open your browser. Serving it (rather than opening the file directly) is what lets the app register a service worker, so it can be installed and work offline.

Best if you want the installable app, or want to read and modify the source.

### Install it as a desktop app

Open the served app — or the hosted version on GitHub Pages — and use your browser's install control:

- **Chrome / Edge** — the install icon in the address bar, or ⋮ → *Cast, save and share* → *Install page as app*
- **Safari (macOS 14+)** — *File* → *Add to Dock*

It then launches in its own window with its own icon, and keeps working with no network.

### Verifying your download

Every asset here is built by the `Release` workflow straight from the tagged commit, and the build is smoke-tested in CI before publishing. Nothing is uploaded by hand.
