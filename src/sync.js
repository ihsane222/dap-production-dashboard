// sync.js — synchronisation avec le store partagé (webhook n8n → fichier OneDrive)
//
// Le backend ("DAP Solidarity — Stockage Production Mensuelle", n8n) est un
// magasin clé-valeur JSON générique : production-data.json = { months: { key: value } }.
//   - POST { monthKey, monthData } → months[monthKey] = monthData
//   - POST { deleteMonth }         → delete months[deleteMonth]
//   - GET                          → renvoie { months }
// Aucune validation de format côté serveur : on y stocke directement les
// snapshots de la réécriture (sous leur propre clé) + les valeurs officielles
// de la convention. C'est ce qui rend le dashboard partagé entre collègues.

const WEBHOOK = 'https://n8n.srv1387885.hstgr.cloud/webhook/dap-solidarity-data';
export const CLOUD_OVERRIDES_KEY = '__overrides__';

async function post(body) {
  try {
    await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    return true;
  } catch (e) {
    console.warn('[sync] POST échoué (hors-ligne ?) — la donnée reste en local', e);
    return false;
  }
}

/** Récupère tout le store partagé. Renvoie l'objet months ({} si échec/vide). */
export async function pullAll() {
  try {
    const res = await fetch(WEBHOOK, { cache: 'no-store' });
    const data = await res.json();
    return (data && data.months && typeof data.months === 'object') ? data.months : {};
  } catch (e) {
    console.warn('[sync] GET échoué — affichage des données locales uniquement', e);
    return {};
  }
}

/** Pousse un snapshot (objet compact tel que stocké en localStorage). */
export function pushSnapshot(compact) {
  if (!compact || !compact.key) return Promise.resolve(false);
  return post({ monthKey: compact.key, monthData: compact });
}

/** Supprime un snapshot du store partagé. */
export function pushDelete(key) {
  return post({ deleteMonth: key });
}

/** Pousse les valeurs officielles de la convention (partagées par l'équipe). */
export function pushOverrides(overrides) {
  return post({ monthKey: CLOUD_OVERRIDES_KEY, monthData: { overrides: overrides || {} } });
}
