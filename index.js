// Bot Docktease : casiers automatiques, fiches à valider, /virer et commandes de secours.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import {
  Client, GatewayIntentBits, ChannelType, PermissionFlagsBits as P, EmbedBuilder, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, SlashCommandBuilder, MessageFlags,
} from 'discord.js';

const need = (k) => { const v = process.env[k]; if (!v) { console.error(`Variable manquante : ${k}`); process.exit(1); } return v; };
const TOKEN = need('DISCORD_TOKEN').trim().replace(/^["']|["']$/g, '').replace(/^Bot\s+/i, ''), GUILD_ID = need('GUILD_ID'), CATEGORY_ID = need('CATEGORY_ID');
const EMPLOYEE_ROLE = need('EMPLOYEE_ROLE_ID'), STAFF_ROLE = need('STAFF_ROLE_ID'), API_KEY = need('BOT_API_KEY');
const SITE_URL = need('SITE_URL').replace(/\/+$/, '');
const LOG_CHANNEL = process.env.LOG_CHANNEL_ID || '';
const PORT = Number(process.env.PORT || 3000);

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const guild = () => client.guilds.cache.get(GUILD_ID);
const EPH = MessageFlags.Ephemeral;

// ---------- Site ----------
async function site(body) {
  try {
    const r = await fetch(SITE_URL + '/api-bot', { method: 'POST', signal: AbortSignal.timeout(12000),
      headers: { 'Content-Type': 'application/json', 'x-api-key': API_KEY }, body: JSON.stringify(body) });
    return await r.json().catch(() => ({ ok: false, error: 'Réponse illisible (HTTP ' + r.status + ')' }));
  } catch (err) { return { ok: false, error: 'Site injoignable : ' + err.message }; }
}
const siteErr = (res) => ({ not_found: "cette personne n'a pas encore de compte sur le site (elle ne s'est jamais connectée)",
  not_pending: `la fiche n'est pas en attente (statut : ${res.status || '?'})`, owner: 'compte propriétaire protégé' }[res.error] ?? res.error);

async function alertStaff(msg) {
  console.error(msg);
  if (!LOG_CHANNEL) return;
  const ch = await guild()?.channels.fetch(LOG_CHANNEL).catch(() => null);
  ch?.send({ content: msg.slice(0, 1900), allowedMentions: { parse: [] } }).catch(() => {});
}

// ---------- Casiers (aucune base de données : le salon porte l'ID du membre dans son sujet) ----------
const topicOf = (id) => `casier:${id}`;
async function findCasier(g, id) {
  const all = await g.channels.fetch();
  return all.find((c) => c && c.parentId === CATEGORY_ID && c.topic === topicOf(id)) ?? null;
}
const slug = (s) => 'casier-' + (String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'employe').slice(0, 80);

async function ensureWebhook(ch, force = false) {
  const hooks = await ch.fetchWebhooks();
  let hook = hooks.find((h) => h.owner?.id === client.user.id && h.name === 'Docktease');
  if (hook && force) { await hook.delete('Recréation du webhook'); hook = null; }
  hook ??= await ch.createWebhook({ name: 'Docktease' });
  const res = await site({ action: 'casier', discord_id: ch.topic.slice(7), webhook_url: hook.url });
  if (!res.ok) await alertStaff(`⚠️ Webhook créé dans <#${ch.id}> mais le site ne l'a pas enregistré : ${res.error}`);
  return hook;
}

const inflight = new Map();
function ensureCasier(member) {
  if (!inflight.has(member.id)) inflight.set(member.id, createCasier(member).finally(() => inflight.delete(member.id)));
  return inflight.get(member.id);
}
async function createCasier(member) {
  const g = member.guild;
  let channel = await findCasier(g, member.id), created = false;
  if (!channel) {
    channel = await g.channels.create({
      name: slug(member.displayName), type: ChannelType.GuildText, parent: CATEGORY_ID, topic: topicOf(member.id),
      reason: 'Nouvel employé',
      permissionOverwrites: [
        { id: g.id, deny: [P.ViewChannel] },
        { id: member.id, allow: [P.ViewChannel, P.ReadMessageHistory], deny: [P.SendMessages, P.AddReactions] },
        { id: STAFF_ROLE, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory] },
        { id: client.user.id, allow: [P.ViewChannel, P.SendMessages, P.ReadMessageHistory, P.EmbedLinks, P.ManageWebhooks, P.ManageChannels] },
      ],
    });
    created = true;
  }
  await ensureWebhook(channel);
  if (created) {
    await channel.send({ content: `👋 Bienvenue <@${member.id}> ! Voici ton casier : tes ventes et locations s'y afficheront.\n\n` +
      `➡️ **Première étape** : connecte-toi sur le site avec Discord et remplis ta fiche :\n${SITE_URL}\n\n` +
      `Dès que ta fiche sera envoyée, la direction pourra la valider ici.`, allowedMentions: { users: [member.id] } });
  }
  return { channel, created };
}

// ---------- Fiche dans le casier ----------
const frDate = (d) => (/^(\d{4})-(\d{2})-(\d{2})$/.exec(d ?? '') ? d.split('-').reverse().join('/') : d || '—');
const btn = (id, label, style) => new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);

const frDT = (d) => (/^(\d{4})-(\d{2})-(\d{2})/.exec(d ?? '') ? d.slice(0, 10).split('-').reverse().join('/') : '');
const STATUS = { pending: ['En attente', 0xE6A100], approved: ['Validée', 0x137A4B], refused: ['Refusée', 0xB3261E], fired: ['Viré', 0x5B6E80] };

async function postFiche(member, p, status = 'pending', extra = {}) {
  const { channel } = await ensureCasier(member);
  const pending = status === 'pending';
  const [label, color] = STATUS[status] ?? ['Statut inconnu', 0x5B6E80];
  const embed = new EmbedBuilder().setColor(color)
    .setTitle(pending ? '📋 Nouvelle fiche à valider' : `📋 Fiche · ${label}`)
    .setDescription(`Fiche de <@${member.id}> sur le site.`)
    .addFields(
      { name: 'Nom', value: `${p.prenom ?? ''} ${p.nom ?? ''}`.trim() || '—', inline: true },
      { name: 'Naissance', value: frDate(p.naissance), inline: true },
      { name: 'Statut', value: label, inline: true });
  if (p.submitted_at) embed.addFields({ name: 'Envoyée le', value: frDT(p.submitted_at) || '—', inline: true });
  if (extra.refusal) embed.addFields({ name: 'Motif du refus', value: String(extra.refusal).slice(0, 200) });
  embed.addFields({ name: 'Pièces (identité, permis)', value: `[Ouvrir la fiche sur le site](${SITE_URL}/fiches)` });
  const msg = { embeds: [embed] };
  if (pending) {
    msg.content = `<@&${STAFF_ROLE}>`;
    msg.allowedMentions = { roles: [STAFF_ROLE] };
    msg.components = [new ActionRowBuilder().addComponents(
      btn(`fiche:approve:${member.id}`, 'Accepter', ButtonStyle.Success),
      btn(`fiche:refuse:${member.id}`, 'Refuser', ButtonStyle.Secondary),
      btn(`fiche:fire:${member.id}`, 'Virer', ButtonStyle.Danger))];
  }
  await channel.send(msg);
  return channel;
}

/** Envoie dans chaque casier la fiche déjà créée sur le site (sans doublon si relancé). */
async function hasFiche(channel) {
  const msgs = await channel.messages.fetch({ limit: 50 });
  return msgs.some((m) => m.author.id === client.user.id && m.embeds.some((e) => e.title?.startsWith('📋')));
}
async function syncFiches(g) {
  const res = await site({ action: 'list' });
  if (!res.ok) return `⚠️ Site : ${siteErr(res)}.`;
  const members = await g.members.fetch();
  let posted = 0, already = 0, absent = 0, noRole = 0, failed = 0;
  for (const f of res.fiches) {
    const m = members.get(f.discord_id);
    if (!m) { absent++; continue; }
    if (!m.roles.cache.has(EMPLOYEE_ROLE)) { noRole++; continue; }
    try {
      const { channel } = await ensureCasier(m);
      if (await hasFiche(channel)) { already++; continue; }
      await postFiche(m, f.profile, f.status, { refusal: f.refusal });
      posted++;
    } catch (err) { failed++; console.error(err); }
  }
  return `✅ **${posted}** fiche(s) envoyée(s) dans les casiers sur ${res.fiches.length}.\n` +
    (already ? `• ${already} déjà présente(s) dans leur casier\n` : '') +
    (noRole ? `• ${noRole} ignorée(s) : plus le rôle employé\n` : '') +
    (absent ? `• ${absent} ignorée(s) : plus sur le serveur\n` : '') +
    (failed ? `• ⚠️ ${failed} erreur(s), voir les logs du bot\n` : '');
}

// ---------- Virer ----------
async function doFire(g, did, by) {
  const res = await site({ action: 'fire', discord_id: did, by });
  const member = await g.members.fetch(did).catch(() => null);
  if (member) await member.roles.remove(EMPLOYEE_ROLE, `Viré par ${by}`).catch(() => {});
  const ch = await findCasier(g, did);
  if (ch) {
    await ch.permissionOverwrites.edit(did, { ViewChannel: false }).catch(() => {});
    if (!ch.name.startsWith('vire-')) await ch.setName(('vire-' + ch.name).slice(0, 100)).catch(() => {});
    await ch.send(`🚪 Employé viré par **${by}**. Accès au site retiré, casier verrouillé.`).catch(() => {});
  }
  return [res.ok ? '✅ Accès au site retiré.' : `⚠️ Site : ${siteErr(res)}.`,
    member ? '✅ Rôle employé retiré.' : '⚠️ Membre introuvable sur le serveur.',
    ch ? '✅ Casier verrouillé.' : 'ℹ️ Pas de casier trouvé.'].join('\n');
}

// ---------- Droits ----------
const isStaff = (i) => i.member.roles.cache.has(STAFF_ROLE) || i.memberPermissions.has(P.Administrator);
const finish = (i, embed, text) => i.editReply({ embeds: [EmbedBuilder.from(i.message.embeds[0]).setColor(embed).setFooter({ text })], components: [] });

// ---------- Boutons ----------
async function onButton(i) {
  if (!isStaff(i)) return i.reply({ content: "⛔ Réservé à la direction.", flags: EPH });
  const [, action, did] = i.customId.split(':');
  const by = i.user.displayName;

  if (action === 'refuse') {
    return i.showModal(new ModalBuilder().setCustomId(`refuse:${did}`).setTitle('Refuser la fiche').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('reason').setLabel('Motif (visible par l’employé)')
        .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(200))));
  }
  if (action === 'fire') {
    return i.reply({ flags: EPH, content: `Virer <@${did}> ? Il perdra l'accès au site et le rôle employé.`, allowedMentions: { parse: [] },
      components: [new ActionRowBuilder().addComponents(btn(`firego:${did}`, 'Oui, virer', ButtonStyle.Danger))] });
  }
  await i.deferUpdate();
  const res = await site({ action: 'approve', discord_id: did, by });
  if (!res.ok) return i.followUp({ content: `⚠️ Impossible : ${siteErr(res)}.`, flags: EPH });
  await finish(i, 0x137A4B, `✅ Acceptée par ${by}`);
  await i.channel.send({ content: `✅ <@${did}> ta fiche a été **validée** ! Tu peux maintenant utiliser le site.`, allowedMentions: { users: [did] } });
}
async function onFireConfirm(i) {
  if (!isStaff(i)) return i.reply({ content: '⛔ Réservé à la direction.', flags: EPH });
  await i.deferUpdate();
  const out = await doFire(i.guild, i.customId.split(':')[1], i.user.displayName);
  await i.editReply({ content: out, components: [] });
}
async function onRefuse(i) {
  if (!isStaff(i)) return i.reply({ content: '⛔ Réservé à la direction.', flags: EPH });
  const did = i.customId.split(':')[1], reason = i.fields.getTextInputValue('reason'), by = i.user.displayName;
  await i.deferUpdate();
  const res = await site({ action: 'refuse', discord_id: did, reason, by });
  if (!res.ok) return i.followUp({ content: `⚠️ Impossible : ${siteErr(res)}.`, flags: EPH });
  await finish(i, 0xB3261E, `❌ Refusée par ${by}` + (reason ? ` : ${reason}` : ''));
  await i.channel.send({ content: `❌ <@${did}> ta fiche a été **refusée**${reason ? ' : ' + reason : ''}. Corrige-la sur le site et renvoie-la.`, allowedMentions: { users: [did] } });
}

// ---------- Commandes ----------
const commands = [
  new SlashCommandBuilder().setName('virer').setDescription("Vire un employé (accès au site retiré, rôle retiré, casier verrouillé)")
    .addUserOption((o) => o.setName('membre').setDescription("L'employé à virer").setRequired(true)),
  new SlashCommandBuilder().setName('casier').setDescription('Commandes de secours des casiers')
    .addSubcommand((s) => s.setName('creer').setDescription('Crée (ou retrouve) le casier d’un membre')
      .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true)))
    .addSubcommand((s) => s.setName('reparer').setDescription('Recrée le webhook du casier et le réenregistre sur le site')
      .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true)))
    .addSubcommand((s) => s.setName('fiche').setDescription('Reposte la fiche à valider dans le casier')
      .addUserOption((o) => o.setName('membre').setDescription('Le membre').setRequired(true)))
    .addSubcommand((s) => s.setName('sync').setDescription('Crée les casiers manquants pour tous les employés'))
    .addSubcommand((s) => s.setName('fiches').setDescription('Envoie dans les casiers toutes les fiches déjà créées sur le site')),
].map((c) => c.setDefaultMemberPermissions(null).toJSON());

async function onCommand(i) {
  if (!isStaff(i)) return i.reply({ content: '⛔ Réservé à la direction.', flags: EPH });
  await i.deferReply({ flags: EPH });
  const g = i.guild;

  if (i.commandName === 'virer') {
    const u = i.options.getUser('membre');
    return i.editReply({ content: `**${u.displayName}**\n` + await doFire(g, u.id, i.user.displayName) });
  }
  const sub = i.options.getSubcommand();
  if (sub === 'sync') {
    const members = (await g.members.fetch()).filter((m) => !m.user.bot && m.roles.cache.has(EMPLOYEE_ROLE));
    let made = 0, fail = 0;
    for (const m of members.values()) {
      try { if ((await ensureCasier(m)).created) made++; } catch (err) { fail++; console.error(err); }
    }
    return i.editReply(`✅ ${members.size} employé(s) vérifié(s) : ${made} casier(s) créé(s)` + (fail ? `, ${fail} erreur(s) (voir les logs du bot).` : '.'));
  }
  if (sub === 'fiches') return i.editReply(await syncFiches(g));
  const member = await g.members.fetch(i.options.getUser('membre').id).catch(() => null);
  if (!member) return i.editReply("⚠️ Ce membre n'est pas sur le serveur.");

  if (sub === 'creer') {
    const { channel, created } = await ensureCasier(member);
    return i.editReply(`${created ? '✅ Casier créé' : 'ℹ️ Le casier existait déjà'} : <#${channel.id}>`);
  }
  if (sub === 'reparer') {
    const { channel } = await ensureCasier(member);
    await ensureWebhook(channel, true);
    return i.editReply(`✅ Webhook recréé et réenregistré : <#${channel.id}>`);
  }
  if (sub === 'fiche') {
    const info = await site({ action: 'info', discord_id: member.id });
    if (!info.ok) return i.editReply(`⚠️ ${siteErr(info)}.`);
    if (info.status !== 'pending' || !info.profile) return i.editReply(`ℹ️ Pas de fiche en attente (statut : ${info.status}).`);
    const ch = await postFiche(member, info.profile);
    return i.editReply(`✅ Fiche postée dans <#${ch.id}>`);
  }
}

// ---------- Évènements Discord ----------
client.on('guildMemberUpdate', async (oldM, newM) => {
  if (newM.guild.id !== GUILD_ID || newM.user.bot || !newM.roles.cache.has(EMPLOYEE_ROLE)) return;
  if (!oldM.partial && oldM.roles.cache.has(EMPLOYEE_ROLE)) return;   // il avait déjà le rôle
  try { await ensureCasier(newM); }
  catch (err) { await alertStaff(`⚠️ Casier non créé pour <@${newM.id}> (${err.message}). Utilisez /casier creer.`); }
});

client.on('interactionCreate', async (i) => {
  try {
    if (i.isChatInputCommand()) await onCommand(i);
    else if (i.isButton() && i.customId.startsWith('fiche:')) await onButton(i);
    else if (i.isButton() && i.customId.startsWith('firego:')) await onFireConfirm(i);
    else if (i.isModalSubmit() && i.customId.startsWith('refuse:')) await onRefuse(i);
  } catch (err) {
    console.error(err);
    const msg = { content: `⚠️ Erreur : ${err.message}`, flags: EPH };
    (i.deferred || i.replied ? i.followUp(msg) : i.reply(msg)).catch(() => {});
  }
});

client.once('clientReady', async () => {
  const g = guild();
  if (!g) { console.error('Le bot n’est pas dans ce serveur (GUILD_ID incorrect ?)'); process.exit(1); }
  await g.commands.set(commands);
  const members = await g.members.fetch();
  let made = 0;   // rattrape les rôles donnés pendant que le bot était éteint
  for (const m of members.values()) {
    if (m.user.bot || !m.roles.cache.has(EMPLOYEE_ROLE)) continue;
    try { if ((await ensureCasier(m)).created) made++; } catch (err) { console.error(err); }
  }
  console.log(`Bot prêt : ${client.user.tag} · ${made} casier(s) rattrapé(s)`);
});

// ---------- Petit serveur HTTP : le site y envoie les fiches ----------
const same = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
http.createServer(async (req, res) => {
  const out = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.method === 'GET') return out(200, { ok: true });
  if (req.method !== 'POST' || req.url !== '/fiche') return out(404, { ok: false });
  if (!same(String(req.headers['x-api-key'] ?? ''), API_KEY)) return out(401, { ok: false });
  try {
    const body = JSON.parse(Buffer.concat(await req.toArray()).toString() || '{}');
    const member = await guild().members.fetch(String(body.discord_id)).catch(() => null);
    if (!member) return out(404, { ok: false, error: 'membre introuvable' });
    await postFiche(member, body.profile ?? {});
    out(200, { ok: true });
  } catch (err) { console.error(err); await alertStaff(`⚠️ Fiche non postée : ${err.message}`); out(500, { ok: false }); }
}).listen(PORT, () => console.log('Serveur HTTP du bot sur le port ' + PORT));

console.log(`Token reçu : ${TOKEN.length} caractères, ${TOKEN.split('.').length} parties (un vrai token : environ 70 caractères, 3 parties)`);
client.login(TOKEN).catch((err) => {
  console.error(`Connexion refusée par Discord : ${err.message}`);
  console.error("→ Portail Discord › onglet Bot (pas OAuth2) › Reset Token › Copy, puis recolle-le dans DISCORD_TOKEN sur Railway.");
  process.exit(1);
});
