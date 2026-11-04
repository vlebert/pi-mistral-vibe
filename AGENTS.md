# AGENTS.md — mistral-vibe (extension pi)

Extension pi qui enregistre un provider `mistral-vibe` parlant à l'API Mistral
avec le même contrat wire que le harness `mistral-vibe` (headers, reasoning,
modèles), en lisant sa config depuis l'installation locale de vibe.

## Règles

- **Parité wire = invariant n°1.** Ne jamais envoyer de champ/header que vibe n'envoie pas, et envoyer ce que vibe envoie (contrat vérifié sur **vibe 3.1.0** + SDK mistralai 3.5.0, adapter `mistralai_vibe_local_harness/vibe/adapters/mistral.py`) :
  - bloc de télémétrie `metadata` dans le body
  - `max_tokens`/`tools`/`reasoning_effort`/`top_p` **omis** quand non définis (vibe 3.x ne passe le kwarg au SDK que quand il a une valeur ; le SDK omet les champs `UNSET` — plus de `null` explicites comme en vibe 2.26)
  - `parallel_tool_calls: true` quand tools présents
  - pas de `prompt_cache_key`
  - `temperature` = valeur de la config vibe (pas de forçage 1.0)
  - `x-affinity` toujours (session id pi, via `request_headers()`)
  - `user-agent` = **UA vibe CLI** (`mistral-client-python/Mistral-Vibe/<version>`) — depuis vibe 3.1.0 il est injecté dans chaque requête via `extra_headers=with_user_agent(...)` → `http_headers` du SDK, qui écrase l'UA SDK par défaut (Speakeasy applique les http_headers en dernier). En vibe 3.0.x c'était l'inverse (UA SDK `speakeasy-sdk/python 2.6.0 …` sur les agent turns)
  - `reasoning_effort` = **niveau tel quel** (`low`/`medium`/`high`/`xhigh`/`max` ; `REASONING_WIRE_VALUES[MISTRAL]` = identité depuis 3.1.0) ; `off` → `"none"` seulement si le modèle est curaté (levels de `known_models.py`, cf. `thinkingLevels` dans `KNOWN_MODEL_SPECS`), sinon champ omis
  - dérive volontaire documentée : `max_tokens` garde la valeur clampée pi pour protéger la fenêtre de contexte (vibe 3.1.0 omet le champ sur les agent turns quand aucun cap n'est configuré). Toute dérive doit être documentée explicitement dans README.md.
- **Champs de messages en snake_case sur le wire** : on fait du fetch brut (pas
  de SDK) → les messages doivent porter `tool_calls`, `tool_call_id`,
  `image_url` (jamais camelCase) — sinon l'API Mistral répond 422
  `extra_forbidden`. Vérifier avec le test tools multi-tour.
- **Sérialisation assistant = SDK 3.5.0** : les messages assistant rejoués
  portent `content: null` quand il n'y a que des tool calls, `prefix: false`
  toujours, et chaque `tool_calls[]` un `index` (défaut SDK `0`, vibe ne le
  renseigne pas). Le `content` suit `_message_payload` de vibe : texte seul →
  **string** (blocs joints par `\n\n`) ; avec reasoning → tableau des thinking
  chunks puis **un seul** text chunk joint. Même règle pour les messages user
  texte (string, pas de tableau de chunks) ; les images forcent le tableau.
  C'est le SDK qui ajoute `prefix`/`index` côté vibe, pas l'adapter —
  recapturer la requête après tout upgrade du SDK.
- **Métadonnées** : `terminal_emulator` est toujours envoyé, avec la valeur
  `unknown` quand l'env ne permet pas de le détecter (port de terminal_detect
  du binaire vibe-rs ; vibe sérialise aussi `unknown`) ; `message_id` est omis
  faute d'équivalent pi au niveau du stream (écart documenté dans README.md).
- **Accumulation des tool calls par index** : Mistral/GLM ne fournit l'id que
  sur certains chunks — ne jamais créer un nouveau bloc par chunk (id absent →
  phantom), adopter id/name quand ils arrivent.
- **Contexte provider = `TranscriptContext` (pi >= 0.86)** : `streamSimple`
  reçoit un transcript normalisé ; `context.systemPrompt` et `context.tools`
  **n'existent plus**. Le prompt et les outils vivent dans les messages
  système du transcript : lire avec `collapseSystemMessages(context)` puis
  `getCurrentSystemPrompt(...)` / `getCurrentTools(...)`. Sinon le modèle
  reçoit une requête sans system prompt ni outils (régression 0.86.0,
  corrigée dans `stream.ts`).
- **Source de vérité du comportement** : le code local de vibe
  (`~/.local/share/uv/tools/mistral-vibe/lib/*/site-packages/`) —
  `mistralai_vibe_local_harness/vibe/adapters/mistral.py` (agent + utility
  turns), `vibe/_runtime_config.py` (`request_headers()`, `output_token_cap()`),
  `mistralai_vibe_local_harness/vibe/completion_profile/` (`reasoning.py`,
  `known_models.py`), `vibe/utils/http.py` (`get_user_agent`),
  `vibe/core/telemetry/` (metadata) — et les modèles du SDK `mistralai`
  (sérialisation `http_headers`, `prefix`, `index`…). Si le comportement de
  vibe change, le provider doit suivre.
- **`wire.ts` reste sans import pi-ai** : c'est la couche testable du contrat
  HTTP. Ne pas y introduire de dépendance.
- **Config** : `~/.vibe/config.toml` (modèles/providers) et `~/.vibe/.env`
  (clé API) sont lus au chargement ; `/reload` dans pi relit tout. Ne jamais
  committer de clé API ni de secrets. Options propres à l'extension dans
  `config.local.json` (gitignoré, à côté des sources, JSON strict) : notamment
  `sendTelemetryMetadata` (bloc télémétrie on/off, env `MISTRAL_VIBE_METADATA`
  en override ponctuel).
- **Seuls les modèles du backend mistral** de la config vibe sont enregistrés
  (pas deepseek/llamacpp).
- **Context window / maxTokens** : table `KNOWN_MODEL_SPECS` dans
  `vibe-config.ts`, keyée par le nom exact du modèle dans le config.toml (qui
  peut différer de l'id catalogue, ex. `mistral-large-4` vs
  `mistral-large-4-0`). Fallback : `auto_compact_threshold` (seuil de
  compaction vibe, PAS la fenêtre réelle) puis 200k conservatif. Voir « Mise à
  jour des modèles connus » ci-dessous.
- **Fichiers** : `index.ts` (entrée), `stream.ts` (streamSimple),
  `vibe-config.ts` (lecture config), `wire.ts` (contrat pur), `README.md`,
  `AGENTS.md`/`CLAUDE.md`, `config.local.json` (options locales, gitignoré,
  jamais commité).
- **Tests/validation** : voir la section « Tests manuels » ci-dessous. Un test
  réel consomme du crédit API → demander l'accord de l'utilisateur avant.

## Mise à jour des modèles connus (KNOWN_MODEL_SPECS)

Les specs officielles (context window, max output) ne sont pas dans la config
vibe. Deux sources à jour, à consulter lors de l'ajout/modification d'un
modèle — pas de fetch automatique au démarrage de pi, c'est une procédure
manuelle documentée :

1. **Catalogue Mistral** (ce que le picker vibe affiche, labels « … (Mistral
   Hosted) ») — donne l'id wire exact, le label, la context window
   (`max_context_length`), vision et function calling :

   ```bash
   KEY=$(grep -oP '(?<=MISTRAL_API_KEY=).*' ~/.vibe/.env | tr -d '"\'')
   curl -s -H "Authorization: Bearer $KEY" \
     "https://api.mistral.ai/v1/model-catalog?surface=vibe-code"
   ```

   Côté vibe, ce catalogue est lu par `vibe/core/config/layers/model_catalog.py`
   (flag `experimental_enable_model_catalog`, défaut false, activable à
   distance par le managed config ; cache `~/.vibe/model_catalog_cache.json`,
   TTL 30 jours). L'extension n'implémente pas cette lecture.

2. **Liste publique des modèles** (complète le catalogue : prix, max output,
   capacités détaillées) :

   ```bash
   curl -s -H "Authorization: Bearer $KEY" "https://api.mistral.ai/v1/models"
   ```

   Fiches : `https://docs.mistral.ai/models/<id>` (context, max output, prix,
   modalités).

Procédure : ajouter/corriger l'entrée dans `KNOWN_MODEL_SPECS` (key = nom
config.toml ; ajouter aussi l'id catalogue s'il diffère), ajouter au besoin un
`[[models]]` dans `~/.vibe/config.toml` (prix en USD/Mtok depuis la fiche),
puis `/reload` et vérifier `/mistral-vibe-status` (ctx affiché). Le catalogue
ne donne ni `max_tokens` ni les prix → maxTokens best-effort depuis la fiche,
prix depuis le config.toml.

## Vérifs rapides

```bash
pi -p "réponds OK" --model mistral-vibe/mistral-vibe-cli-latest   # chargement + appel réel
# dans pi : /mistral-vibe-status
# debug wire : MISTRAL_VIBE_DEBUG=1 pi ...  → /tmp/mistral-vibe-debug.log
```

NB : `pi --list-models` ne liste pas les providers d'extensions ; vérifier
l'enregistrement via le sélecteur /model ou `/mistral-vibe-status`.

## Tests manuels (non scriptés)

Checklist à exécuter après toute modification du wire, du mapping ou de la
lecture config. Ne lancer les tests en gras (crédit API) qu'après accord de
l'utilisateur.

1. **Chargement & enregistrement**
   - `pi -p "réponds OK" --model mistral-vibe/mistral-vibe-cli-latest` → réponse OK.
   - `/mistral-vibe-status` → baseUrl `https://api.mistral.ai/v1`, UA
     `mistral-client-python/Mistral-Vibe/<version installée>` (ex. 3.1.0),
     modèles attendus (cli-latest + ceux du TOML backend mistral), aucune
     warning.
2. **Parité wire** (sans crédit)
   - `MISTRAL_VIBE_DEBUG=1 pi -p …` puis inspecter `/tmp/mistral-vibe-debug.log`
     (event `request`) : `user-agent` = UA vibe CLI
     (`mistral-client-python/Mistral-Vibe/<version installée>`),
     `x-affinity` présent, `accept: text/event-stream`, `prompt_cache_key: null`
     (champ absent du body), `reasoning_effort` = niveau tel quel (`low`/`medium`/
     `high`/`xhigh`/`max` ; `none` pour off sur modèle curaté, champ absent sinon),
     `temperature` conforme, `metadata_call_type: main_call`, `toolCount` > 0 et
     `systemPromptChars` > 0 (contexte bien transmis). Une clé invalide
     (`MISTRAL_API_KEY=x`) suffit pour produire le log sans consommer de crédit.
   - Alternative : hooks pi `before_provider_headers` / `before_provider_request`.
   - Rejouer le builder `wire.ts` hors-ligne (node, type stripping natif) : URL
     `${origin}/v1/chat/completions`, headers exacts, ThinkChunk rejoués, pas de
     `prompt_cache_key`, `max_tokens`/`tools`/`reasoning_effort` **absents**
     (pas `null`) quand non définis, `parallel_tool_calls: true` quand tools,
     bloc `metadata` présent.
3. **Thinking / reasoning** (crédit)
   - `--model mistral-vibe/zai-glm-5-2:off` → log : `reasoning_effort` **absent**
     du body (champ omis, comme vibe 3.1.0 sur un modèle non curaté — zai-glm-5-2
     n'est pas dans known_models.py).
   - `:off` sur un modèle curaté (cli-latest, large-4, zai-glm-5-3) → `none`.
   - `:low` → `low` ; `:medium` → `medium` ; `:high` → `high` ; `:xhigh` →
     `xhigh` ; `:max` → `max` (niveau tel quel depuis vibe 3.1.0) ;
     `temperature` = valeur de la config vibe (1.0 pour zai/large-4 ;
     vibe 3.1.0 ne force pas).
   - Prompt exigeant du raisonnement → event `thinking_delta` + `contentTypes`
     contenant `thinking` (une question triviale peut légitimement ne pas
     produire de thinking).
4. **Cache hit/miss** (crédit)
   - Deux appels mêmes préfixe + même `x-affinity` : premier `cached_tokens: 0`,
     second > 0 (dans le log `done` : `usage.cacheRead` > 0).
5. **Pricing** (crédit)
   - Log `done` : vérifier la cohérence
     `cost = input×input_price + output×output_price + cacheRead×cached_price`
     (prix par Mtok : cli-latest $1.5/$0.15/$7.5, zai $1.4/$0.14/$4.4).
6. **Multi-tour avec tools** (crédit)
   - Session interactive où l'agent appelle un outil puis continue : pas d'erreur
     sur le replay assistant (ThinkChunk), tool call IDs valides côté Mistral
     (9 caractères), fin par `stopReason: toolUse` puis `stop`.
7. **Overflow → auto-compaction**
   - Erreur `context length exceeded` côté Mistral → le handler `message_end`
     préfixe `context_length_exceeded:` et pi compacte puis retente.
8. **Config & clé**
   - Modifier un prix ou ajouter un modèle dans `~/.vibe/config.toml`, `/reload`,
     vérifier `/mistral-vibe-status`. Retirer `MISTRAL_API_KEY` de `~/.vibe/.env`
     → erreur claire « No API key … ». L'env var doit primer sur le .env.
9. **Régression wire après upgrade vibe**
   - Après `uv tool upgrade mistral-vibe` : re-vérifier le contrat HTTP de vibe
     n'a pas changé (comparer `mistralai_vibe_local_harness/vibe/adapters/mistral.py`
     — kwargs envoyés, `request_headers()`/`output_token_cap()` dans
     `vibe/_runtime_config.py`, `completion_profile/reasoning.py`
     REASONING_WIRE_VALUES + `request_reasoning`, `completion_profile/known_models.py`
     pour la curation des niveaux, `vibe/utils/http.py` `get_user_agent`, et la
     version du SDK `mistralai` — `mistralai/client/_version.py` `__user_agent__`).
     Mettre à jour `DEFAULT_VERSION`, `MISTRAL_SDK_USER_AGENT`, le UA effectivement
     envoyé (`buildUserAgent(version)`), `KNOWN_MODEL_SPECS` (dont `thinkingLevels`)
     et les commentaires si besoin.
