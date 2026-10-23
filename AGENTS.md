# AGENTS.md — mistral-vibe (extension pi)

Extension pi qui enregistre un provider `mistral-vibe` parlant à l'API Mistral
avec le même contrat wire que le harness `mistral-vibe` (headers, reasoning,
modèles), en lisant sa config depuis l'installation locale de vibe.

## Règles

- **Parité wire = invariant n°1.** Ne jamais envoyer de champ/header que vibe n'envoie pas, et envoyer ce que vibe envoie (contrat vérifié sur **vibe 3.0.2** + SDK mistralai 2.6.0, adapter `mistralai_vibe_local_harness/vibe/adapters/mistral.py`) :
  - bloc de télémétrie `metadata` dans le body
  - `max_tokens`/`tools`/`reasoning_effort`/`top_p` **omis** quand non définis (vibe 3.x ne passe le kwarg au SDK que quand il a une valeur ; le SDK omet les champs `UNSET` — plus de `null` explicites comme en vibe 2.26)
  - `parallel_tool_calls: true` quand tools présents
  - pas de `prompt_cache_key`
  - `temperature` = valeur de la config vibe (pas de forçage 1.0)
  - `x-affinity` toujours (session id pi)
  - `user-agent` = **SDK Mistral par défaut** (`speakeasy-sdk/python 2.6.0 2.884.13 1.0.0 mistralai`) — vibe 3.x n'envoie le UA vibe CLI (`mistral-client-python/Mistral-Vibe/<version>`) que sur les completions utilitaires, pas sur les agent turns
  - dérive volontaire documentée : `max_tokens` garde la valeur clampée pi pour protéger la fenêtre de contexte (vibe 3.x calcule un cap dynamique). Toute dérive doit être documentée explicitement dans README.md.
- **Champs de messages en snake_case sur le wire** : on fait du fetch brut (pas
  de SDK) → les messages doivent porter `tool_calls`, `tool_call_id`,
  `image_url` (jamais camelCase) — sinon l'API Mistral répond 422
  `extra_forbidden`. Vérifier avec le test tools multi-tour.
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
  (`~/.local/share/uv/tools/mistral-vibe/lib/*/site-packages/vibe/`,
  surtout `mistralai_vibe_local_harness/vibe/adapters/mistral.py` pour les
  agent turns, `vibe/core/llm/backend/mistral.py` pour le legacy,
  `vibe/utils/http.py` pour `get_user_agent`) et le SDK `mistralai`. Si le
  comportement de vibe change, le provider doit suivre.
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
- **Fichiers** : `index.ts` (entrée), `stream.ts` (streamSimple),
  `vibe-config.ts` (lecture config), `wire.ts` (contrat pur), `README.md`,
  `AGENTS.md`/`CLAUDE.md`, `config.local.json` (options locales, gitignoré,
  jamais commité).
- **Tests/validation** : voir la section « Tests manuels » ci-dessous. Un test
  réel consomme du crédit API → demander l'accord de l'utilisateur avant.

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
     `speakeasy-sdk/python 2.6.0 2.884.13 1.0.0 mistralai`, modèles attendus
     (cli-latest + ceux du TOML backend mistral), aucune warning.
2. **Parité wire** (sans crédit)
   - `MISTRAL_VIBE_DEBUG=1 pi -p …` puis inspecter `/tmp/mistral-vibe-debug.log`
     (event `request`) : `user-agent` = SDK Mistral (`speakeasy-sdk/python …`),
     `x-affinity` présent, `accept: text/event-stream`, `prompt_cache_key: null`
     (champ absent du body), `reasoning_effort`/`temperature` conformes au
     niveau demandé, `metadata_call_type: main_call`, `toolCount` > 0 et
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
     du body (champ omis, comme vibe 3.x sur un modèle non curaté).
   - `:low` → `none` ; `:medium` (défaut pi) et `:high` → `high` ; `temperature`
     = valeur de la config vibe (1.0 pour zai/large-4 ; vibe 3.x ne force pas).
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
     n'a pas changé (comparer `mistralai_vibe_local_harness/vibe/adapters/mistral.py`,
     `vibe/utils/http.py`, et la version du SDK `mistralai` — le UA SDK dépend
     de `mistralai/client/_version.py`). Mettre à jour `DEFAULT_VERSION`,
     `MISTRAL_SDK_USER_AGENT` et les commentaires si besoin.
