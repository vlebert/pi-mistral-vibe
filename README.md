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
pi -m mistral-vibe/zai-glm-5-2               # modèle de ta config vibe
pi -m mistral-vibe/devstral-small-latest

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
| Modèles | `~/.vibe/config.toml` → `[[models]]` dont le provider tourne sur le backend mistral + les `DEFAULT_MODELS` du harness (`mistral-vibe-cli-latest`, `devstral-small-latest`) |
| Version UA | paquet installé (`uv/tools/mistral-vibe/.../vibe/__init__.py`), fallback constant |

Seuls les modèles du **backend mistral** sont enregistrés (les modèles
deepseek/llamacpp de la config sont ignorés). Les entrées de la config
remportent sur les défauts du harness en cas de doublon d'id.

## Contrat wire (ce que le provider envoie)

Headers, par requête chat streaming :

```
POST {origin}/v1/chat/completions
authorization: Bearer <key>
content-type: application/json
accept: text/event-stream
user-agent: mistral-client-python/Mistral-Vibe/<version>
x-affinity: <session_id>
```

Body :

- `model`, `messages` (ThinkChunk rejoués pour le multi-tour), `stream: true`
- `reasoning_effort`: `none` (minimal/low) / `high` (medium/high/xhigh/max),
  **omis** si thinking `off` — pour **tous** les modèles (comme vibe)
- `temperature`: forcée à **1.0** dès que `reasoning_effort` est envoyé
- `max_tokens`, `tools`, `tool_choice`
- **pas de** `prompt_cache_key` (vibe ne l'envoie pas)

Différences volontaires avec le provider `mistral` natif de pi :

| | `mistral` (pi natif) | `mistral-vibe` |
|---|---|---|
| `reasoning_effort` | seulement pour 3 ids de modèles, sinon `prompt_mode` | **tous** les modèles (none/high) |
| `temperature` | non forcée | forcée à 1.0 si reasoning |
| `prompt_cache_key` | envoyé si cache retention | jamais |
| `x-affinity` | si cache retention | toujours (comme vibe) |
| User-Agent | SDK pi | `mistral-client-python/Mistral-Vibe/<version>` |

## Vérification de la parité

1. `/mistral-vibe-status` → base URL, User-Agent, modèles, source de clé.
2. Comparer le body/headers émis : `pi` a un hook `before_provider_request`
   (console.log du payload) et `before_provider_headers`.
3. Test réel : `pi -p "dis bonjour" -m mistral-vibe/zai-glm-5-2` (consomme du
   crédit API).

## Dépannage

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
- `index.ts` — chargement, `registerProvider`, commande de statut, handler
  d'overflow.

Pas de dépendances npm (parser TOML minimal embarqué).
