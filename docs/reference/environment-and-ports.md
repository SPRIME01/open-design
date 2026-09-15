# Reference: Environment Variables & Ports

**Parent:** [`docs/architecture.md`](file:///home/sprime01/projects/open-design/docs/architecture.md) · **Subsystem Guide:** [`docs/subsystems/daemon.md`](file:///home/sprime01/projects/open-design/docs/subsystems/daemon.md) · **Source Map:** [`docs/source-map.md`](file:///home/sprime01/projects/open-design/docs/source-map.md)

This document provides the reference specification for all environment variables, configuration flags, default network ports, and path derivation rules in Open Design.

---

## 1. Environment Variables

| Variable | Target Subsystem | Type / Format | Purpose & Constraints |
|---|---|---|---|
| `OD_DATA_DIR` | Daemon | Absolute directory path | Overrides the canonical daemon persistence root. Resolved once on startup into `RUNTIME_DATA_DIR`. Defaults to standard OS app data path. |
| `OD_PORT` | Daemon / Web | Integer port (e.g. `7456`) | Daemon HTTP listening port. Exported by `tools-dev` and consumed by `apps/web/next.config.ts` for `/api/*` rewrites. |
| `OD_WEB_PORT` | Web | Integer port (e.g. `17573`) | Next.js HTTP listening port for the web sidecar. |
| `OD_NEXT_STRATEGY_ROLLOUT` | Daemon | `0` or `1` | Global process switch for the OD Next prompt composition pipeline. `1` forces OD Next; `0` forces legacy prompts. |
| `OD_MEDIA_CONFIG_DIR` | Daemon | Absolute path | Narrow configuration override for `media-config.json` only. Not a second daemon data root. |
| `OD_MOCKS_TRACE` | Mock CLIs | 8-character trace hash | Activates replay of anonymized recorded Langfuse traces in `mocks/bin/`. |
| `OD_MOCKS_NO_DELAY` | Mock CLIs | `1` | Disables artificial playback delays when running mock agent CLIs in automated tests. |
| `PAGER` | Subprocesses | String | Default `cat` to prevent child CLI processes from hanging on interactive pagers. |

### Strict Forbidden Variables:
- ❌ `NEXT_PORT`: Prohibited. The web listener is governed strictly by `OD_WEB_PORT` and `tools-dev` `--web-port`.
- ❌ Hardcoded `.data` or `~/.open-design`: Must not be referenced directly in code; all storage must flow through `RUNTIME_DATA_DIR`.

---

## 2. Default Ports & Allocation Rules

| Role | Documented Default | CLI Override Flag | Notes |
|---|---|---|---|
| **Daemon HTTP API** | `7456` | `--daemon-port <port>` | Express loopback server (`127.0.0.1`). |
| **Web Frontend** | `17573` | `--web-port <port>` | Next.js web listener. |
| **Mock Updater Fixture** | `18456` | Fixed internal | Managed by `tools-serve start updater`. |

### Port Invariants:
1. **Ports are Transport Details Only**: Network ports do not define process identity, namespace boundaries, or filesystem storage locations.
2. **Dynamic Allocation**: If default ports are in use and flags are not specified, `tools-dev` searches sequentially for the next available TCP ports.

---

## 3. Sidecar Stamp CLI Arguments

Sidecar subprocesses receive their identity exclusively through five argv flags:

```bash
--od-stamp-channel <channel>     # Release channel (stable, beta, prerelease, preview, dev)
--od-stamp-namespace <namespace> # Isolation namespace (default, or test worker ID)
--od-stamp-source <source>       # Process source (tools-dev, packaged)
--od-stamp-mode <mode>           # Execution mode (development, production)
--od-stamp-app <app>             # Role (daemon, web, desktop)
```

---

## 4. Source Trail

- [`apps/daemon/src/daemon-paths.ts`](file:///home/sprime01/projects/open-design/apps/daemon/src/daemon-paths.ts) — `OD_DATA_DIR` and `RUNTIME_DATA_DIR` resolution.
- [`tools/dev/src/cli.ts`](file:///home/sprime01/projects/open-design/tools/dev/src/) — Port flags and lifecycle orchestration.
- [`apps/web/next.config.ts`](file:///home/sprime01/projects/open-design/apps/web/) — `OD_PORT` rewrite handler.
- [`packages/sidecar/src/stamp.ts`](file:///home/sprime01/projects/open-design/packages/sidecar/src/) — Stamp argument validation.
