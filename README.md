# mistral-vibe (pi provider)

Provider pi `mistral-vibe` qui parle à l'API Mistral **exactement comme le
harness `mistral-vibe`** : mêmes headers HTTP, même mécanisme de reasoning,
mêmes modèles — de sorte que, vu du backend Mistral, les requêtes sont
indiscernables de celles émises par vibe.

## Installation

Aucune : l'extension est auto-découverte depuis `~/.pi/agent/extensions/`
(dossier git versionné). Après un changement, recharger avec `/reload` (dans
pi) — le fichier `~/.vibe/config.toml` et `~/.vibe/.env` sont relus à chaque
chargement.

## Utilisation

```bash
pi -m mistral-vibe/mistral-vibe-cli-latest   # défaut harness (= mistral-medium-3.5)
pi -m mistral-vibe/mistral-large-4-0        # Mistral Large 4
pi -m mistral-vibe/zai-glm-5-2               # modèle de ta config vibe
pi -m mistral-vibe/zai-glm-5-3               # modèle de ta config vibe

# NB: les providers d'extensions n'apparaissent pas dans `pi --list-models`;
# vérifier l'enregistrement via le sélecteur /model ou /mistral-vibe-status.
```

Dans l'UI : `/model` puis sélection, ou Ctrl+P. Statut du provider :

```
/mistral-vibe-status
```

## Sources de configuration (lues au chargement)

| Donnée | Source |
|---|---|
| Clé API | env `MISTRAL_API_KEY`, puis `~/.vibe/.env` (là où vibe persiste sa clé) |
| `api_base` | `~/.vibe/config.toml` → `[[providers]]` `mistral` (défaut `https://api.mistral.ai/v1`) |
| Modèles | `~/.vibe/config.toml` → `[[models]]` dont le provider tourne sur le backend mistral + le modèle par défaut du harness `mistral-vibe-cli-latest` (= mistral-medium-3.5) |
| Prix | **USD officiels** (mistral.ai/pricing) : hardcodés pour `mistral-vibe-cli-latest` ($1.5 / $0.15 cache / $7.5), lus du `config.toml` pour les modèles de la config (GLM 5.2/5.3 : $1.4 / $0.14 cache / $4.4) |
| Version UA | paquet installé (`uv/tools/mistral-vibe/.../vibe/__init__.py`), fallback constant |

Seuls les modèles du **backend mistral** sont enregistrés (les modèles
deepseek/llamacpp de la config sont ignorés). Les entrées de la config
remportent sur les défauts du harness en cas de doublon d'id.

## Config locale de l'extension (`config.local.json`)

Fichier gitignoré à côté de l'extension
(`~/.pi/agent/extensions/mistral-vibe/config.local.json`), relu au
`/reload`. JSON strict (pas de commentaires). Options :

| Clé | Défaut | Effet |
|---|---|---|
| `sendTelemetryMetadata` | `true` | envoie le bloc de télémétrie `metadata` dans chaque requête. Parité wire — vibe l'envoie toujours, même avec `enable_telemetry = false` (ce réglage ne coupe que le canal d'événements séparé) — mais le bloc décrit le CLI vibe (`agent_entrypoint: "cli"`, `client_name: "vibe_cli"`) alors que pi n'est pas ce client. `false` = moins de fausse télémétrie, au prix d'une divergence wire visible (champ absent d'une requête vibe). |

Override ponctuel sans toucher au fichier : `MISTRAL_VIBE_METADATA=off|on`
(prime sur le fichier). Le réglage effectif est visible dans
`/mistral-vibe-status` (ligne `telemetry block`).

## Configurer un modèle dans Mistral Vibe (`~/.vibe/config.toml`)

Pour qu'un modèle soit proposé par le plugin, il doit avoir une entrée
`[[models]]` dans `~/.vibe/config.toml` dont le provider tourne sur le backend
mistral. Exemple complet :

```toml
# Provider mistral — optionnel : ces valeurs sont les défauts du plugin.
# À ne déclarer que pour surcharger api_base ou la variable de clé.
[[providers]]
name = "mistral"
api_base = "https://api.mistral.ai/v1"
api_key_env_var = "MISTRAL_API_KEY"
backend = "mistral"

[[models]]
name = "zai-glm-5-3"            # id envoyé sur le wire (champ `model`) et id pi
alias = "zai-glm-5-3"           # nom affiché (optionnel, défaut : name)
provider = "mistral"            # ⚠️ doit être sur le backend mistral
thinking = "high"               # off | minimal | low | medium | high | xhigh | max
temperature = 1.0
input_price = 1.4               # $/Mtok — utilisés pour le cost tracking pi
output_price = 4.4
cached_input_price = 0.14
supports_images = false
auto_compact_threshold = 300000 # seuil de compaction vibe, PAS la fenêtre réelle
```

Règles de reconnaissance :

- **Backend mistral obligatoire** : seules les entrées `[[models]]` dont le
  provider est `mistral` (ou un `[[providers]]` avec
  `backend = "mistral"`) sont enregistrées. Les modèles sur un backend
  `generic` (deepseek, scaleway, opencode-zen…) sont ignorés.
- **`name` = identifiant** : c'est l'id pi (`pi -m mistral-vibe/<name>`) et la
  valeur `model` envoyée à l'API Mistral. `alias` ne sert qu'à l'affichage.
- **Doublons** : une entrée `[[models]]` de même `name` qu'un modèle intégré
  du harness (ex. `mistral-vibe-cli-latest`) remplace celui-ci ; entre deux
  entrées de la config, la première gagne.
- **Clé API** : résolue comme vibe — variable d'env (par défaut
  `MISTRAL_API_KEY`, cf. `api_key_env_var` du provider), puis `~/.vibe/.env`.
- **Prix** : `input_price` / `output_price` / `cached_input_price` en USD par
  Mtok ; à défaut, 0.
- **Fenêtre de contexte** : `auto_compact_threshold` n'est **pas** la fenêtre
  réelle — la vraie valeur vient de `KNOWN_MODEL_SPECS` (voir section
  suivante), sinon repli sur `auto_compact_threshold` ou 200k. Surchargeable
  via `models.json` de pi.
- Après toute modification du toml : **`/reload`** dans pi (la config est
  relue à chaque chargement de l'extension) et vérifier avec
  `/mistral-vibe-status`.

## Contrat wire (ce que le provider envoie)

Parité cible : **vibe 3.1.0** agent turns (`mistralai_vibe_local_harness/vibe/
adapters/mistral.py` + SDK `mistralai` 3.5.0).

Headers, par requête chat streaming :

```
POST {origin}/v1/chat/completions
authorization: Bearer <key>
content-type: application/json
accept: text/event-stream
user-agent: mistral-client-python/Mistral-Vibe/3.1.0
x-affinity: <session_id>
```

> **User-Agent** : depuis vibe 3.1.0, les appels agent envoient le **UA vibe
> CLI** (`mistral-client-python/Mistral-Vibe/<version>`) : vibe l'injecte dans
> chaque requête via `extra_headers=with_user_agent(...)` → `request_headers()`
> → `http_headers` du SDK, et Speakeasy applique les `http_headers` par requête
> **après** l'UA par défaut du SDK (`basesdk.py`), donc il l'écrase. (En
> vibe 3.0.x c'était l'inverse : UA SDK `speakeasy-sdk/python …` sur les agent
> turns.)

Body (mirroir de la sérialisation SDK `mistralai` 3.5.0 / vibe 3.1.0) :

- `model`, `messages` (ThinkChunk rejoués pour le multi-tour ; champs en
  **snake_case** : `tool_calls`, `tool_call_id`, `image_url` — fetch brut sans
  SDK), `stream: true`
- messages assistant rejoués, sérialisés comme le SDK 3.5.0 : `content`
  explicite `null` quand il n'y a que des tool calls, `prefix: false` toujours
  présent, et chaque `tool_calls[]` porte `index` (défaut SDK `0`, l'adapter
  vibe ne le renseigne pas). Forme du `content` (cf. `_message_payload` de
  vibe) : texte seul → **string** (blocs joints par `\n\n`) ; avec reasoning
  → tableau des thinking chunks puis **un seul** text chunk joint. Les messages
  user texte partent aussi en string (les images forcent le tableau)
- `reasoning_effort`: le niveau est envoyé **tel quel** — `low`→`"low"`,
  `medium`→`"medium"`, `high`→`"high"`, `xhigh`→`"xhigh"`, `max`→`"max"`
  (`REASONING_WIRE_VALUES[MISTRAL]` = identité depuis vibe 3.1.0 ; la réduction
  none/high de la 3.0.x n'existe plus). `minimal` (niveau pi seul) → `"low"`.
  `off` → `"none"` **seulement si le modèle est curaté** (levels connues dans
  `KNOWN_MODEL_SPECS`, tirées de known_models.py de vibe 3.1.0 : cli-latest
  `["high"]`, large-4 et glm-5-3 `["low","high","max"]`), sinon **champ omis**
  (vibe omet le champ pour `off` quand le support reasoning du modèle est
  inconnu)
- `temperature`: **toujours envoyée** avec la valeur de la config vibe
  (`[[models]] temperature`) ; repli : options pi explicites, sinon défaut
  `ModelConfig` 0.2
- `metadata`: bloc de télémétrie vibe (os, arch, os_version — `VERSION_ID` de
  `/etc/os-release` sur Linux, sinon release du noyau —, version, session_id,
  terminal_emulator — `unknown` si indétectable, call_type
  `main_call`, call_source `vibe_code`, host_kind `local`, agent_entrypoint
  `cli`, client_name `vibe_cli`…) — désactivable via
  `config.local.json` (`sendTelemetryMetadata: false`, divergence documentée ;
  vibe l'envoie inconditionnellement, même avec `enable_telemetry = false`).
  `message_id` (ajouté par vibe 3.1) est **omis** : pi n'expose pas d'id de
  message utilisateur au niveau du stream (écart documenté)
- `max_tokens`: la valeur pi (clampée à la fenêtre de contexte) — **dérive
  volontaire** : vibe 3.1.0 omet le champ sur les agent turns quand aucun cap
  n'est configuré (`output_token_cap()` → None), mais pi s'en sert pour
  protéger la fenêtre de contexte
- `tools`: tableau quand il y a des outils, **`parallel_tool_calls: true`**
  toujours envoyé avec (vibe 3.1.x) ; **champ omis** quand il n'y a pas d'outils
  (vibe 3.x omet les champs unset, contrairement à vibe 2.26 qui envoyait
  `null` explicite)
- `top_p`: envoyé avec la valeur `[[models]] top_p` de la config vibe, ou
  l'override `samplingParams` de pi (`models.json` ou options de requête)
- **pas de `tool_choice`** : vibe ne passe jamais ce kwarg sur les agent turns
- champs unset : le builder `wire.ts` les omet (`max_tokens`, `tools`,
  `reasoning_effort`, `top_p`), comme vibe (le SDK omet les `UNSET`) —
  **exception côté provider** : `max_tokens` est toujours envoyé (dérive
  volontaire documentée ci-dessus)
- **pas de** `prompt_cache_key` (vibe ne l'envoie pas)

Différences volontaires avec le provider `mistral` natif de pi :

| | `mistral` (pi natif) | `mistral-vibe` |
|---|---|---|
| `reasoning_effort` | seulement pour 3 ids de modèles, sinon `prompt_mode` | **tous** les modèles (niveau tel quel, `none` pour off si curaté, omis sinon) |
| `temperature` | non gérée | valeur de la config vibe |
| `metadata` | non envoyé | bloc télémétrie vibe |
| `prompt_cache_key` | envoyé si cache retention | jamais |
| `x-affinity` | si cache retention | toujours (comme vibe) |
| User-Agent | SDK pi | UA vibe CLI (`mistral-client-python/Mistral-Vibe/<version>`, comme vibe 3.1.0) |
| `parallel_tool_calls` | non envoyé | `true` quand tools présents |

## Vérification de la parité

1. `/mistral-vibe-status` → base URL, User-Agent, modèles, source de clé.
2. **Debug wire** : `MISTRAL_VIBE_DEBUG=1 pi …` (ou dans une session interactive)
   → une ligne JSON par requête dans `/tmp/mistral-vibe-debug.log`
   (`MISTRAL_VIBE_DEBUG_LOG` pour changer le chemin) : request (url, headers,
   `reasoning_effort`, température, x-affinity, `prompt_cache_key`), premier
   delta thinking, usage/cost et stopReason au `done`. Vérifie reasoning, cache
   et pricing sans toucher au code.
3. Comparer le body/headers émis : hooks pi `before_provider_request` /
   `before_provider_headers`.
4. **Test différentiel automatisé** : `npm run test:differential` envoie les
   mêmes scénarios (texte, tool call, tool calls parallèles, replay thinking)
   au harness vibe et à pi via un proxy enregistreur, puis compare la forme des
   requêtes (mode scripté gratuit et déterministe ; `--mode live` pour une
   requête réelle). Détails et divergences attendues : `AGENTS.md`, section
   « Test différentiel vibe ↔ pi ». Ajouter un scénario = éditer
   `tests/differential/scenarios.mjs`. Scénarios image : vérification manuelle
   uniquement (vibe headless n'inline pas les images).
5. Test réel : `pi -p "…" --model mistral-vibe/zai-glm-5-2` ou `zai-glm-5-3` (consomme du crédit).

> Note plateforme : le `fetch` de Node (undici) ajoute `accept-language` et
> `sec-fetch-mode: cors` à toute requête, absents de celles de vibe (httpx).
> Sans effet côté API Mistral ; les supprimer demanderait de quitter `fetch`
> pour `node:http`.

## Fenêtre de contexte des modèles

La config vibe (`auto_compact_threshold`) est un **seuil d'auto-compaction**, pas
la fenêtre réelle du modèle. L'extension utilise donc des specs connues
(`KNOWN_MODEL_SPECS`, d'après docs.mistral.ai), avec repli sur
`auto_compact_threshold` :

| Modèle | Context window | Max output |
|---|---|---|
| zai-glm-5-2 | 1 048 576 | 128 000 |
| zai-glm-5-3 | 1 048 576 | 128 000 |
| zai-glm-5-3-flash | 1 048 576 | 128 000 |
| deepseek-v4-1-flash-1017 | 1 048 576 | 128 000 |
| mistral-large-4 / mistral-large-4-0 | 1 048 576 | 262 144 |
| mistral-medium-latest | 262 144 | 16 384 |
| mistral-vibe-cli-latest (medium-3.5) | 262 144 | 16 384 |

Toute valeur reste surchargeable via `models.json` de pi
(`mistral-vibe/<id>.contextWindow` / `maxTokens`).

## Thinking

- Depuis vibe 3.1.0, le niveau part **tel quel** sur le wire : `:low` →
  `reasoning_effort: "low"`, `:medium` → `"medium"`, `:high` → `"high"`,
  `:xhigh` → `"xhigh"`, `:max` → `"max"` (la réduction none/high de vibe 3.0.x
  est abandonnée). `:minimal` (niveau pi seul) → `"low"`.
- `:off` → `"none"` si le modèle est curaté (levels connues dans
  `KNOWN_MODEL_SPECS`), **champ omis** sinon — comme vibe 3.1.0
  (`request_reasoning` : off → None quand le support du modèle est inconnu).
- La température envoyée est celle de la config vibe (1.0 pour zai/large-4) —
  vibe 3.x ne force pas la température.
- Le modèle peut légitimement ne pas émettre de thinking sur une question
  triviale (GLM 5.2 décide) ; `contentTypes` du log montre
  `["text","thinking","text"]` quand il raisonne.

## Dépannage

- **Le modèle ne voit ni le system prompt ni les outils** (il répond comme un
  chatbot nu, sans contexte pi) : régression de compatibilité avec pi 0.86.0,
  qui est passé d'un `Context` (`systemPrompt` / `tools`) à un
  `TranscriptContext` normalisé. Le provider lit désormais le prompt et les
  outils via `collapseSystemMessages()` / `getCurrentSystemPrompt()` /
  `getCurrentTools()` (voir `stream.ts`). Vérifier avec
  `MISTRAL_VIBE_DEBUG=1` : `systemPromptChars` et `toolCount` doivent être > 0
  dans le log `request`.
- **`No API key ...`** : la clé doit être dans l'env ou `~/.vibe/.env`
  (variable `MISTRAL_API_KEY` — le `api_key_env_var` du provider config est
  respecté si tu l'as surchargé).
- **Modèle absent** : il n'est pas sur le backend mistral dans
  `~/.vibe/config.toml` (ex. les modèles deepseek) → normal.
- **Overflow de contexte** : normalisé vers `context_length_exceeded` pour
  déclencher l'auto-compaction de pi (handler `message_end` scoped au
  provider).
- **Changements de config vibe** : `/reload` dans pi.

## Développement

Repo git autonome : `~/.pi/agent/extensions/mistral-vibe/`.

- `wire.ts` — helpers wire purs (aucun import pi-ai) : headers, mapping
  reasoning, transform de messages, parsing SSE. Testable isolément.
- `vibe-config.ts` — lecture de `~/.vibe` (config.toml, .env, version).
- `stream.ts` — `streamSimple` (fetch brut + parsing SSE + events pi).
  Reçoit un `TranscriptContext` pi >= 0.86 et en extrait prompt système et
  outils avant construction de la requête.
- `index.ts` — chargement, `registerProvider`, commande de statut, handler
  d'overflow.
- `tests/differential/` — test différentiel vibe ↔ pi (proxy enregistreur,
  scénarios, comparaison de forme) : `npm run test:differential`.

Pas de dépendances npm (parser TOML minimal embarqué).

## Compatibilité pi

| pi | Contexte provider | État |
|---|---|---|
| < 0.86 | `Context` avec `systemPrompt` / `tools` | historique |
| >= 0.86 | `TranscriptContext` (prompt + outils dans les messages système) | supporté |
