# StoriBloom.AI

Enterprise-ready collaborative workshop platform with participant rooms, presenter controls, org admin, and super-admin operations.

## One-Page Sales Narrative

### StoriBloom in one line
StoriBloom is the collaboration operating system for high-impact group work, combining real-time facilitation, guided AI, and enterprise controls so teams move from discussion to clear outcomes faster.

### The business problem
Most workshops and team sessions fail for the same reasons:
- energy drops after kickoff,
- participation is uneven,
- decisions are hard to trace,
- and outputs are inconsistent in quality.

Organizations spend significant time and budget on collaboration, but still struggle to produce repeatable, measurable outcomes.

### What StoriBloom changes
StoriBloom turns workshops into a structured, accountable workflow:
- **Mission Control for facilitators:** live room signals, risk detection, and one-click interventions.
- **Guided co-creation for participants:** phase-based collaboration with AI support that stays on-policy.
- **Operational control for leaders:** org admin and super-admin consoles for licenses, sites, health, usage, and governance.

This creates consistency without killing creativity.

### Why teams buy it
- **Higher quality outputs:** built-in phase structure, evidence capture, and export-ready deliverables.
- **Better participation:** contribution equity tracking and nudges help balance voices in real time.
- **Faster cycle time:** teams move from idea to draft to final output in one system.
- **Enterprise trust:** tenant isolation, role-based access, audit trails, retention controls, and policy-safe AI behavior.

### Primary use cases
StoriBloom supports multiple collaboration modes in one platform:
- strategic storytelling and community narrative work,
- creative writing and structured drafting,
- project ideation and concept development,
- restorative/team alignment conversations.

### What makes it hard to replace
- **Facilitation intelligence:** stage timing, interventions, replay, and room-level insight.
- **AI with governance:** configurable policy controls and transparent AI receipts.
- **Outcomes visibility:** measurable participation, completion, and quality trends by org/license/site.
- **Operational depth:** licensing, entitlements, approvals, reliability workflows, and trust-center visibility.

### Economic value for organizations
StoriBloom reduces facilitation overhead, increases workshop completion quality, and makes collaboration outcomes trackable across teams. Instead of “another chat tool,” it functions as a repeatable execution layer for group thinking and decision-making.

### Ideal buyer profile
- Learning & development leaders
- People/HR and culture teams
- Innovation/program offices
- Community and impact programs
- Consulting/facilitation organizations delivering workshops at scale

### Close
If your organization runs recurring group sessions and needs better outcomes, stronger participation, and enterprise-grade control, StoriBloom is built to become the default platform for collaborative work.

---

## Demo Runbook (for presentation)

### 1. Prerequisites
- Node `20.x` (project target is `>=20 <21`)
- npm
- AWS credentials with DynamoDB access (or your existing deployed API environment)

### 2. Install dependencies
```bash
npm install
```

### 3. Run locally
Default local ports:
- API: `4000` (from `api/.env`)
- Web: `5173`

If your API runs on a different port, set `VITE_API_PROXY_TARGET` before starting web.

```bash
npm run dev
```

App URLs:
- Participant/Admin entry: `http://localhost:5173/`
- Org Admin: `http://localhost:5173/admin`
- Super Admin: `http://localhost:5173/super-admin`
- Presenter HUD: `http://localhost:5173/presenter`

---

## Demo Credentials + Codes

### Super Admin login (no code)
- Email: `demetrious@hiddengeniusproject.org`
- Path: `/super-admin`

### Generate your demo codes (recommended flow)
1. Log in as Super Admin.
2. In **Generate Access Codes**, create codes in this order:
   - `ADMIN` x `1` (for org setup)
   - `PRESENTER` x `1` per workshop mode you plan to demo
   - `PARTICIPANT` x `6-12` per workshop mode
3. Use shared values for demo consistency:
   - `Org ID`: `ORG-DEMO`
   - `License ID`: `LIC-DEMO`
   - `Site ID`: `E1`

Code types:
- `A-...` = Org Admin
- `P-...` = Presenter
- `U-...` = Participant

---

## Demo Code Worksheet (fill after generation)

### Core roles
| Role | Where to log in | Code to use |
|---|---|---|
| Super Admin | `/super-admin` | `demetrious@hiddengeniusproject.org` |
| Org Admin | `/admin` | `A-________________` |
| Presenter | `/` (main login) | `P-________________` |
| Participant 1 | `/` (main login) | `U-________________` |
| Participant 2 | `/` (main login) | `U-________________` |

### Workshop mode packs
| Use case | Mode to select in generator | Presenter code | Participant codes |
|---|---|---|---|
| Hidden Genius Project | `HIDDEN_GENIUS` | `P-________________` | `U-____, U-____, U-____` |
| Creative Writing | `CREATIVE_WRITING` | `P-________________` | `U-____, U-____, U-____` |
| Project Ideation | `PROJECT_IDEATION` | `P-________________` | `U-____, U-____, U-____` |
| Restorative Circle | `RESTORATIVE_CIRCLE` | `P-________________` | `U-____, U-____, U-____` |

---

## Suggested live demo sequence (10-15 min)

1. **Super Admin view**
   - Log in with the authorized email.
   - Show health/analytics and code generation.
2. **Org Admin view**
   - Log in with `A-...` code.
   - Set workshop mode, AI behavior, phase count, and template.
3. **Presenter view**
   - Log in via main page with `P-...` code.
   - Show room controls, stage progression, and gallery.
4. **Participant view**
   - Join with `U-...` codes in separate windows/incognito tabs.
   - Show room timeline rail, chat collaboration, and stage progression.

---

## Optional: seed many demo codes via script

If you want bulk seeded site/room/code CSVs:

```bash
node scripts/seedDynamo.mjs --region us-west-2 --rooms 5 --codes 30
```

Outputs are written under `seed-output/<timestamp>/` including:
- `sites.csv`
- `codes_<SITE>.csv`
- `rooms_<SITE>.csv`

Then pick one `A-...`, one `P-...`, and several `U-...` from CSVs for your demo.

---

## Troubleshooting

### Fail-safe demo mode (no AWS/OpenAI dependency)

If AWS DynamoDB or OpenAI is unstable, run the API with in-memory fallback data:

```bash
DEMO_MODE_FALLBACK=1 npm run dev:api
```

What this enables:
- Guest auth + session tokens still work.
- Code login works with demo defaults (`A-DEMO`, `P-DEMO`, `U-DEMO1` ... `U-DEMO6`).
- Room assignment, room state, chat messages, voting, and presenter controls run from in-memory data.
- Admin/super-admin read paths degrade to demo-safe data when Dynamo is unavailable.
- AI edit/generation falls back to deterministic guidance text when OpenAI is unavailable.

Optional overrides:
- `DEMO_DEFAULT_ORG_ID` (default `ORG-DEMO`)
- `DEMO_DEFAULT_LICENSE_ID` (default `LIC-DEMO`)
- `DEMO_DEFAULT_SITE_ID` (default `E1`)

### `POST /auth/guest 500` + `CredentialsProviderError: Could not load credentials from any providers`
Your API can answer `/health`, but it cannot read/write DynamoDB without AWS credentials.

Fix:

1. Configure AWS credentials (choose one):
```bash
# IAM Identity Center / SSO
aws configure sso
aws sso login --profile <your-profile>
```
or
```bash
# Access key flow
aws configure
```

2. Verify credentials:
```bash
aws sts get-caller-identity
```

3. If using a non-default profile, export it before running API:
```bash
export AWS_PROFILE=<your-profile>
```

4. Restart API:
```bash
npm run dev:api
```

If you then see table errors, create/update tables:
```bash
npm run ddb:apply
```
