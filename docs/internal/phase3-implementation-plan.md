# Phase 3 implementation plan: the `deploy/` base and config artifact

Detailed implementation plan for **Phase 3** of the GitOps migration
(`gitops-implementation-plan.md`), the phase that introduces the Kustomize
`deploy/` base, the Flux dependency graph, and the published deployment-config
artifact. It realizes ADR 0031 (GitOps deployment base) and consumes the ADR
0030 / ADR 0033 build lane (the signed Hauler haul), which is already live.

Phases 0 (chart publishing) and 2 (the build lane) are complete: all 14 Scout
charts publish as signed OCI artifacts, and every `main` build produces a
signed haul recording the platform at digests. Phase 3 is where a cluster first
*consumes* those artifacts through Flux instead of Ansible, which is the point
at which the config-staleness problem the whole effort targets actually closes.

## Goal and definition of done

Ship a `deploy/` directory: a Kustomize base per component consumed by Flux,
published as a versioned config artifact whose chart pins and image refs are
stamped from the build manifest (the haul) at publish time.

**Done when CI stands up the full platform, optional components included, from
the published config artifact, and passes the ingest and authorization
suites.** (`gitops-implementation-plan.md`, Phase 3.)

Phase 3 does **not** cut any real cluster over (that is Phase 4 dev / Phase 5
on-prem) and does **not** introduce SOPS (Phase 4). It proves the base in CI.

## Decisions

Made with the SRE lead 2026-08-10:

1. **Realm decomposition is staged, not full.** Keep the base realm as one
   keycloak-config-cli fragment; split out only the already-feature-gated
   clients (xnat, chat/open-webui). Full per-component client ownership (the
   ADR 0031 ideal) is deferred: it is a real config-cli multi-file-sync spike
   and offers little immediate value once the base realm is chart-delivered.
   This divergence from ADR 0031 is deliberate and recorded here.
2. **First vertical slice = the ingest path.** 3b converts postgres + lake
   (minio/hive) + orchestrator (cassandra/es/temporal) + extractor to Flux and
   switches `deploy-and-test`. It is the exact DoD gate (the ingest suite) and
   exercises operator/CR ordering, DB-init Jobs, and the config artifact in one
   slice.
3. **This lands on the fork first.** Implementation opens against
   `andrey-embarklabs/scout` for review; nothing reaches `washu-tag/scout`
   without an explicit go, per the ADR-still-draft, outward-facing posture.
4. **Ansible `deploy-and-test` stays in parallel** the whole phase, gated on
   `ansible/**`, per ADR 0031's "prove the base before any cutover." No cluster
   loses its Ansible path in Phase 3.
5. **Layer 0 stays Ansible.** k3s, traefik, cert-manager, registry mirrors, CA
   trust, and the Flux install itself remain node-bootstrap concerns (ADR 0031
   Layer 0). Flux owns everything from the operators up.
6. **Config artifact is an OCI artifact** consumed by a Flux `OCIRepository`,
   published by CI alongside the haul, pinned by digest. No git-branch chart
   sources anywhere (ADR 0031: "never a chart from a git branch").
7. **Secrets are fixed-name plain Secrets in Phase 3.** The base references
   Secrets by fixed name only; CI seeds them exactly as today (dummy values in
   `.github/ci_resources/inventory.yaml`). SOPS/ESO materialization is Phase 4.

## Target architecture: the four new pieces

1. **`deploy/<component>/` Kustomize bases.** Each holds the component's
   `HelmRelease` (pointing at `oci://ghcr.io/washu-tag/charts/<name>` for Scout
   charts, or the upstream chart's `HelmRepository`/`OCIRepository`), its
   operator/CR split where it has one, its fixed-name `Secret` stubs, and its
   post-deploy `Job`s.
2. **A Flux Kustomization `dependsOn` DAG** that reproduces today's Ansible
   ordering, with CEL `healthCheckExprs` (Flux >= 2.5) gating each edge.
3. **The config artifact:** the rendered `deploy/` tree published as a signed
   OCI artifact, with `name:tag@digest` stamped from the haul at publish, a
   `cluster-vars` ConfigMap consumed via `postBuild.substituteFrom` under
   `StrictPostBuildSubstitutions`, a `required-vars` file checked by site-repo
   CI, and structured settings delivered as site-overlay `valuesFrom`.
4. **A staged Keycloak realm decomposition** into keycloak-config-cli fragments
   (base realm + feature-flag client fragments).

## The Flux Kustomization DAG

Derived from `ansible/playbooks/main.yaml` order plus the inter-service
dependencies each role's secrets/DBs/endpoints imply. Every operator that owns
CRDs is split into an install Kustomization and a CR Kustomization, with a
health-gated edge between them (the CRD-ordering deadlock pattern: a CR applied
before its CRD exists fails the dry-run; split and `dependsOn` the operator).

| Layer | Kustomization(s) | dependsOn | health gate |
|---|---|---|---|
| **0 infra** (Ansible Layer 0, not Flux) | k3s, traefik, cert-manager, Flux install | node bootstrap | n/a |
| **1 operators** | cnpg, minio-operator, cass-operator, eck-operator, keycloak-operator; (strimzi, gpu-operator optional) | infra | Deployment Available |
| **2a stateful CRs** | postgres `Cluster`, minio `Tenant`, cassandra `CassandraDatacenter`, elasticsearch `Elasticsearch`, keycloak `Keycloak` CR, valkey | matching operator | CR Ready (CEL) |
| **2b init Jobs** | postgres DB/role init, minio IAM bootstrap, keycloak realm import | its layer-2a CR | Job Complete |
| **3 data/auth** | hive (pg+minio), oauth2-proxy (valkey+realm), opa (minio), temporal (cassandra+es), trino (minio+hive+opa+keycloak+cert) | layer 2 | rollout ready |
| **4 apps** | superset (pg+valkey+trino+kc), extractor (pg+minio+temporal+trino-rw), jupyter, report-viewer, monitoring (prometheus/loki/alloy/grafana), launchpad | layer 3 | rollout ready |
| **5 feature Components** | chat/open-webui (+bootstrap Job), playbooks/voila, xnat, data-generator, gpu | as flagged | rollout ready |

Ordering anomaly to carry over: Ansible deploys keycloak (layer 2) before minio
(the keycloak OPA-bundle-publisher SPI points at the minio service), but that is
a *runtime* dependency, not a deploy-order one, so it is not a `dependsOn` edge.

Non-idempotent init Jobs (realm import, minio IAM, DB creation) become dependent
Flux Jobs. DB creation moves into CNPG `bootstrap.initdb` + `managed.roles`
where it can; the residual `ALTER SCHEMA public OWNER` steps stay a small Job.

Optional components become **Kustomize Components** toggled per site:
`enable_chat` -> chat, `enable_playbooks` -> voila, `enable_xnat` -> xnat,
`enable_data_generator` -> data-generator, gpu-by-inventory -> gpu. Each Component
carries its own resources and its Keycloak client fragment (xnat and chat only,
per decision 1).

## Sub-phases

Vertical-slice-first: each sub-phase is behavior-preserving for the deployed
artifact and keeps the existing CI gates green. The Ansible path stays live
throughout.

### 3a: `deploy/` scaffold + Flux plumbing + config-artifact publish (unconsumed)

- Create the `deploy/` tree, the layer-organized Kustomization DAG skeleton, the
  `cluster-vars` substitution wiring, and the `required-vars` file.
- Add a CI job (main-only, gated like `publish-haul`) that reads the haul
  manifest, stamps `name:tag@digest` into the base's chart/image refs, and
  publishes the signed config artifact (OCI, digest-pinned).
- Verify by `kustomize build` + `flux build`/`flux-local` render only. Nothing
  is deployed yet, so this cannot regress a deploy gate.

### 3b: vertical slice, the ingest path (the first real deploy switch)

- Convert postgres, lake (minio + hive), orchestrator (cassandra + es +
  temporal), and extractor to Flux bases.
- Switch `deploy-and-test` to stand these up via Flux from the config artifact
  instead of the per-playbook `ansible-playbook` loop.
- **Gate: the ingest suite (`tests/ingest`) stays green.** This is the DoD gate
  and proves operator/CR ordering, the DB-init Jobs, health-check edges, and the
  stamped config artifact end to end.
- **Measure CI capacity here** (risk 2) before committing to the full switch.

### 3c: auth + analytics

- Add keycloak (operator + CR + realm import) + oauth2-proxy, trino + opa, and
  superset as Flux bases.
- Switch `smoke-test` analytics to Flux.
- **Gate: the data-authorization suite.** This forces the realm work (3d).

### 3d: staged realm decomposition

- Move the base realm into a chart-delivered keycloak-config-cli fragment
  (still one fragment), rendering user-profile authz attributes from the shared
  `trino_attribute_filters` map via `valuesFrom`.
- Split the two feature-gated clients (xnat, chat) into their own fragments,
  owned by those Kustomize Components, fed to config-cli's directory import.
- Leave shared clientScopes (`trino-audience`, `minio-authorization`,
  `report-viewer-audience`) and all other clients in the base fragment.
- **Gate: config-cli import is clean and the authz suite stays green.**

### 3e: remaining components + feature Components

- jupyter, voila, monitoring, open-webui (+ bootstrap Job), report-viewer,
  launchpad as Flux bases; chat / xnat / playbooks / gpu / data-generator as
  Kustomize Components.
- Switch `smoke-test` notebooks to Flux. XNAT and GPU stay dev-cluster-proven
  (not added to CI), matching today.

### 3f: chart-owned derived config fan-out

- Move the remaining `aws_deployment` / `air_gapped` / `server_hostname`-driven
  conditionals out of the Ansible values templates and into chart `_helpers.tpl`
  (the spark-defaults migration in `hl7-transformer` is the Phase-0 precedent).
- **Gate: chart render is byte-identical to the Ansible render** in both modes
  (the spark-defaults verification method).

## Config artifact detail

- **Stamping:** the publish job resolves each Scout chart to its published OCI
  version and each image to `repo:tag@digest` from the haul, and writes those
  into the base's `HelmRelease` `chartRef`/values. Placeholder refs live in git;
  concrete refs only ever exist in the published artifact (ADR 0030 Section 2).
- **cluster-vars:** the ~100 flat site scalars in today's inventory `vars`
  blocks (hostnames, storage classes, sizes, namespaces, endpoints, regions,
  `deployment_type`, `air_gapped`) become one `cluster-vars` ConfigMap consumed
  via `postBuild.substituteFrom`. `StrictPostBuildSubstitutions` makes an
  undefined variable fail the build rather than render empty.
- **required-vars:** a file in the artifact listing the substitution keys a site
  must set; site-repo CI (Phase 4) and the staging reconciler (Phase 5) check it
  before a bump merges. Introduced here so the contract exists from the start.
- **structured settings** (`trino_attribute_filters`, `scout_dashboard_bundles`,
  `scout_models`, storage-class maps, `*_resources` dicts) are site-overlay
  values via `valuesFrom`, not flattened into cluster-vars.
- The `versions.yaml` refs (~40 keys) stop being a deploy-time source of truth
  and become build-manifest-stamped; Renovate keeps tracking them for the build
  lane, not for deploy.

## Secrets in Phase 3

The base references ~60 Secrets by fixed name (postgres-user, keycloak-admin,
keycloak-config, per-client `*_client_secret`, s3/lake creds, valkey auth, TLS,
etc.). In Phase 3 these are plain `Secret`s; CI seeds them from the existing
`.github/ci_resources/inventory.yaml` dummy values. SOPS-encrypted-in-git
(default), ESO (cloud), and vault fallback are Phase 4, when dev clusters prove
the secrets path before on-prem depends on it.

## CI switch and capacity (the main risk)

Today CI stands the platform up twice (deploy-and-test's ingest stack; smoke-test
split across two runners) via serial `ansible-playbook` runs on 4-CPU / 72GB
GitHub-hosted runners, with heavy per-component resource trimming and disk-
pressure workarounds. Adding Flux + helm-controller pulling OCI charts is the
~50% capacity the plan flags. Mitigations: keep the smoke-test two-runner split;
reuse the existing k3s image-import + CRI-pin flow so Flux consumes locally
imported images; measure headroom on 3b before switching 3c/3e. If a Flux deploy
does not fit the runner, that is a finding to surface, not something to paper
over with silent component drops.

## Guardrails and best practices

- Every operator/CR pair is two Kustomizations with a health-gated edge; never
  one Kustomization applying a CRD and its CR together (dry-run deadlock).
- Digest-pinned everything (charts and images) via the stamped artifact; a
  moving `current`-style pointer is only ever added on the site-config artifact
  (Phase 5), never on Scout artifacts.
- Behavior-preserving per sub-phase; the ingest and authz suites are the
  gates, and the Ansible path stays green in parallel.
- No silent capacity caps: if a Flux deploy can't fit CI, say so.
- Fork-first; no `washu-tag` PR without an explicit go.

## Verification

- 3a: `kustomize build` + `flux build` render cleanly; config artifact publishes
  and is digest-pinned; nothing deployed.
- 3b: ingest suite green via a Flux-stood-up stack; operator/CR ordering and
  DB-init Jobs converge without manual intervention; CI capacity measured.
- 3c/3d: data-authorization suite green; config-cli import clean with the base +
  feature-flag fragments.
- 3e: smoke-test notebooks green via Flux.
- 3f: chart render byte-identical to the Ansible render in on-prem and aws modes.
- End state: a single CI path stands the full platform (optional components
  included) up from the published config artifact and passes ingest + authz.

## Execution order

1. 3a (scaffold + publish, unconsumed) — safe, no deploy gate touched.
2. 3b (ingest slice) — the first real switch and the capacity checkpoint.
3. 3d realm spike can begin in parallel (it blocks 3c).
4. 3c (auth + analytics) once 3d's base-realm fragment is ready.
5. 3e (remaining + feature Components), then 3f (derived-config fan-out).
6. Gate: hand the result over for the `washu-tag` decision; Phase 4 (site repos,
   SOPS, dev cutover) is a separate plan.
