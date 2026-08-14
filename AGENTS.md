# AGENTS.md — mistral-vibe (extension pi)

Extension pi qui enregistre un provider `mistral-vibe` parlant à l'API Mistral
avec le même contrat wire que le harness `mistral-vibe` (headers, reasoning,
modèles), en lisant sa config depuis l'installation locale de vibe.

## Règles

- **Parité wire = invariant n°1.** Ne jamais envoyer de champ/header que vibe
  n'envoie pas (en particulier : pas de `prompt_cache_key`, `reasoning_effort`
  pour TOUS les modèles thinking, température forcée à 1.0 quand reasoning
  actif, `x-affinity` toujours, `user-agent:
  mistral-client-python/Mistral-Vibe/<version>`). Toute dérive doit être
  documentée explicitement dans README.md.
- **Source de vérité du comportement** : le code local de vibe
  (`~/.local/share/uv/tools/mistral-vibe/lib/*/site-packages/vibe/`,
  surtout `core/llm/backend/mistral.py`, `utils/http.py`) et le SDK
  `mistralai`. Si le comportement de vibe change, le provider doit suivre.
- **`wire.ts` reste sans import pi-ai** : c'est la couche testable du contrat
  HTTP. Ne pas y introduire de dépendance.
- **Config** : `~/.vibe/config.toml` (modèles/providers) et `~/.vibe/.env`
  (clé API) sont lus au chargement ; `/reload` dans pi relit tout. Ne jamais
  committer de clé API ni de secrets.
- **Seuls les modèles du backend mistral** de la config vibe sont enregistrés
  (pas deepseek/llamacpp).
- **Fichiers** : `index.ts` (entrée), `stream.ts` (streamSimple),
  `vibe-config.ts` (lecture config), `wire.ts` (contrat pur), `README.md`,
  `AGENTS.md`/`CLAUDE.md`.
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
     `mistral-client-python/Mistral-Vibe/<version>`, modèles attendus
     (cli-latest + ceux du TOML backend mistral), aucune warning.
2. **Parité wire** (sans crédit)
   - `MISTRAL_VIBE_DEBUG=1 pi -p …` puis inspecter `/tmp/mistral-vibe-debug.log`
     (event `request`) : `user-agent` vibe, `x-affinity` présent, `accept:
     text/event-stream`, `prompt_cache_key: null`, `reasoning_effort`/`temperature`
     conformes au niveau demandé.
   - Alternative : hooks pi `before_provider_headers` / `before_provider_request`.
   - Rejouer le builder `wire.ts` hors-ligne (tsx) : URL `${origin}/v1/chat/completions`,
     headers exacts, ThinkChunk rejoués, pas de `prompt_cache_key`.
3. **Thinking / reasoning** (crédit)
   - `--model mistral-vibe/zai-glm-5-2:off` → log : `reasoning_effort` absent.
   - `:low` → `none` ; `:medium` (défaut pi) et `:high` → `high` ; `temperature`
     forcée à 1.0 dès que `reasoning_effort` est envoyé.
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
   - Après `uv tool upgrade mistral-vibe` : re-vérifier UA (version) et que le
     contrat HTTP de vibe n'a pas changé (comparer `mistral.py`/`http.py`).
