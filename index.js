require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  ContainerBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  RoleSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  MessageFlags,
  ChannelType,
} = require('discord.js');

// ======================================================================
// CONFIG
// ======================================================================
const CONFIG = {
  PREFIX: process.env.PREFIX || '+',
  BRAND_NAME: process.env.BRAND_NAME || 'Server Moderation System',
  ACCENT_COLOR: 0x5865f2,
  DANGER_COLOR: 0xed4245,
  SUCCESS_COLOR: 0x57f287,
  WARN_COLOR: 0xfee75c,
};

// ======================================================================
// PER-SERVER TICKET CONFIG (staff role / category / panel channel)
// Set via the /ticket_panel_setup command and saved to a JSON file so it
// survives restarts.
// ======================================================================
const TICKET_CONFIG_PATH = path.join(__dirname, 'data', 'ticketConfig.json');

function loadAllTicketConfigs() {
  try {
    if (!fs.existsSync(TICKET_CONFIG_PATH)) return {};
    return JSON.parse(fs.readFileSync(TICKET_CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('Failed to load ticket config:', e);
    return {};
  }
}
function saveAllTicketConfigs(data) {
  try {
    fs.mkdirSync(path.dirname(TICKET_CONFIG_PATH), { recursive: true });
    fs.writeFileSync(TICKET_CONFIG_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to save ticket config:', e);
  }
}
function getGuildTicketConfig(guildId) {
  const all = loadAllTicketConfigs();
  return all[guildId] || null;
}
function setGuildTicketConfig(guildId, cfg) {
  const all = loadAllTicketConfigs();
  all[guildId] = cfg;
  saveAllTicketConfigs(all);
}

// Temporary in-memory state while an admin is walking through /ticket_panel_setup.
// key: `${guildId}-${userId}` -> { staffRoleId, ticketCategoryId, panelChannelId }
const setupSessions = new Map();
function sessionKey(guildId, userId) {
  return `${guildId}-${userId}`;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildModeration,
  ],
  partials: [Partials.Channel, Partials.GuildMember, Partials.User],
});

// In-memory tracking of scheduled temp-ban expiries. This resets on restart —
// for long-running production use, persist this list to a database instead.
const activeTempBans = new Map();

// ======================================================================
// CONTAINER HELPERS (Components V2)
// ======================================================================
function baseContainer(color) {
  return new ContainerBuilder().setAccentColor(color);
}

function addFooter(container) {
  container.addSeparatorComponents(sep => sep.setSpacing(SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(td => td.setContent(`-# ${CONFIG.BRAND_NAME}`));
  return container;
}

const V2_FLAGS = MessageFlags.IsComponentsV2;
const V2_EPHEMERAL_FLAGS = MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral;

// ---------- /say container ----------
function buildSayContainer(title, message) {
  const container = baseContainer(CONFIG.ACCENT_COLOR);
  container.addTextDisplayComponents(td =>
    td.setContent(title ? `# ${title}\n${message}` : message)
  );
  return addFooter(container);
}

// ---------- Ban DM container ----------
function buildBanDmContainer(guild, moderatorTag, reason, days) {
  const container = baseContainer(CONFIG.DANGER_COLOR);
  const durationText = days && days > 0 ? `${days} day(s)` : 'Permanent';
  container.addTextDisplayComponents(td => td.setContent('# You have been banned'));
  container.addSeparatorComponents(sep => sep.setSpacing(SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(td =>
    td.setContent(
      `**Server:** ${guild.name}\n**Moderator:** ${moderatorTag}\n**Duration:** ${durationText}\n**Reason:** ${reason}`
    )
  );
  return addFooter(container);
}

// ---------- Timeout DM container ----------
function buildTimeoutDmContainer(guild, moderatorTag, reason, minutes) {
  const container = baseContainer(CONFIG.WARN_COLOR);
  container.addTextDisplayComponents(td => td.setContent('# You have been timed out'));
  container.addSeparatorComponents(sep => sep.setSpacing(SeparatorSpacingSize.Small));
  container.addTextDisplayComponents(td =>
    td.setContent(
      `**Server:** ${guild.name}\n**Moderator:** ${moderatorTag}\n**Duration:** ${minutes} minute(s)\n**Reason:** ${reason}`
    )
  );
  return addFooter(container);
}

// ---------- Generic result container (shown in-channel to the moderator) ----------
function buildResultContainer(color, title, lines) {
  const container = baseContainer(color);
  container.addTextDisplayComponents(td => td.setContent(`# ${title}\n${lines}`));
  return addFooter(container);
}

// ---------- Ticket panel container (the public panel users click) ----------
function buildTicketPanelContainer(guild, description) {
  const container = baseContainer(CONFIG.ACCENT_COLOR);
  const desc =
    description ||
    'Need help or have an issue? Open a private ticket below and a staff member will be with you shortly.';

  const section = new SectionBuilder()
    .addTextDisplayComponents(td => td.setContent(`# Support\n${desc}`))
    .setThumbnailAccessory(thumb =>
      thumb.setURL(guild.iconURL({ size: 256 }) || 'https://cdn.discordapp.com/embed/avatars/0.png')
    );

  container.addSectionComponents(section);
  container.addSeparatorComponents(sep => sep.setSpacing(SeparatorSpacingSize.Small));
  container.addActionRowComponents(row =>
    row.addComponents(
      new ButtonBuilder().setCustomId('create_ticket').setLabel('Create Ticket').setStyle(ButtonStyle.Primary)
    )
  );
  return addFooter(container);
}

// ---------- Ticket setup wizard container (ephemeral) ----------
function buildTicketSetupContainer(session) {
  const container = baseContainer(CONFIG.ACCENT_COLOR);
  container.addTextDisplayComponents(td =>
    td.setContent('# Ticket Panel Setup\nSelect each option below, then click **Save & Send Panel**.')
  );
  container.addSeparatorComponents(sep => sep.setSpacing(SeparatorSpacingSize.Small));

  const staffText = session.staffRoleId ? `<@&${session.staffRoleId}>` : 'Not selected';
  const categoryText = session.ticketCategoryId ? `<#${session.ticketCategoryId}>` : 'Not selected';
  const channelText = session.panelChannelId ? `<#${session.panelChannelId}>` : 'Not selected';
  container.addTextDisplayComponents(td =>
    td.setContent(
      `**Staff Role:** ${staffText}\n**Ticket Category:** ${categoryText}\n**Panel Channel:** ${channelText}`
    )
  );

  container.addActionRowComponents(row =>
    row.addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId('setup_staff_role')
        .setPlaceholder('Select staff role')
        .setMinValues(1)
        .setMaxValues(1)
    )
  );

  container.addActionRowComponents(row =>
    row.addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId('setup_ticket_category')
        .setPlaceholder('Select ticket category')
        .setChannelTypes(ChannelType.GuildCategory)
        .setMinValues(1)
        .setMaxValues(1)
    )
  );

  container.addActionRowComponents(row =>
    row.addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId('setup_panel_channel')
        .setPlaceholder('Select panel channel')
        .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setMinValues(1)
        .setMaxValues(1)
    )
  );

  const allSet = Boolean(session.staffRoleId && session.ticketCategoryId && session.panelChannelId);
  container.addActionRowComponents(row =>
    row.addComponents(
      new ButtonBuilder()
        .setCustomId('setup_confirm')
        .setLabel('Save & Send Panel')
        .setStyle(ButtonStyle.Success)
        .setDisabled(!allSet),
      new ButtonBuilder().setCustomId('setup_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary)
    )
  );

  return addFooter(container);
}

// ---------- Ticket welcome container (inside the created ticket channel) ----------
function buildTicketWelcomeContainer(user, guild) {
  const container = baseContainer(CONFIG.ACCENT_COLOR);
  container.addTextDisplayComponents(td =>
    td.setContent(
      `# Welcome, ${user.username}\nYour ticket has been created. Please describe your issue in detail and a staff member will respond shortly.\n\n**Server:** ${guild.name}`
    )
  );
  container.addSeparatorComponents(sep => sep.setSpacing(SeparatorSpacingSize.Small));
  container.addActionRowComponents(row =>
    row.addComponents(
      new ButtonBuilder().setCustomId('claim_ticket').setLabel('Claim').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('close_ticket').setLabel('Close Ticket').setStyle(ButtonStyle.Danger)
    )
  );
  return addFooter(container);
}

function buildSimpleInfoContainer(color, title, message) {
  const container = baseContainer(color);
  container.addTextDisplayComponents(td => td.setContent(`# ${title}\n${message}`));
  return addFooter(container);
}

// ======================================================================
// PERMISSION HELPERS
// ======================================================================
function hasBanPermission(member) {
  return member.permissions.has(PermissionFlagsBits.BanMembers);
}
function hasTimeoutPermission(member) {
  return member.permissions.has(PermissionFlagsBits.ModerateMembers);
}
function hasSayPermission(member) {
  return member.permissions.has(PermissionFlagsBits.ManageMessages);
}
function isStaff(member) {
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  const cfg = getGuildTicketConfig(member.guild.id);
  if (cfg && cfg.staffRoleId && member.roles.cache.has(cfg.staffRoleId)) return true;
  return false;
}

// ======================================================================
// CORE ACTIONS (shared between slash and prefix commands)
// ======================================================================
async function performBan(guild, moderator, targetUser, days, reason) {
  const member = await guild.members.fetch(targetUser.id).catch(() => null);
  if (member && !member.bannable) {
    return { success: false, error: 'I cannot ban this user (role hierarchy or missing permission).' };
  }

  let dmSent = true;
  try {
    const dm = await targetUser.createDM();
    await dm.send({
      components: [buildBanDmContainer(guild, moderator.user.tag, reason, days)],
      flags: V2_FLAGS,
    });
  } catch (e) {
    dmSent = false;
  }

  try {
    await guild.members.ban(targetUser.id, { reason: `${reason} | by ${moderator.user.tag}` });
  } catch (e) {
    return { success: false, error: 'Failed to ban this user: ' + e.message };
  }

  if (days && days > 0) {
    const key = `${guild.id}-${targetUser.id}`;
    const existing = activeTempBans.get(key);
    if (existing) clearTimeout(existing);

    const ms = days * 24 * 60 * 60 * 1000;
    const timeoutHandle = setTimeout(async () => {
      try {
        await guild.members.unban(targetUser.id, 'Temporary ban duration expired');
      } catch (e) {
        // already unbanned, or the bot lost permission — ignore
      }
      activeTempBans.delete(key);
    }, ms);
    activeTempBans.set(key, timeoutHandle);
  }

  return { success: true, dmSent };
}

async function performTimeout(guild, moderator, targetUser, minutes, reason) {
  const member = await guild.members.fetch(targetUser.id).catch(() => null);
  if (!member) {
    return { success: false, error: 'This user is not in the server.' };
  }
  if (!member.moderatable) {
    return { success: false, error: 'I cannot timeout this user (role hierarchy or missing permission).' };
  }

  let dmSent = true;
  try {
    const dm = await targetUser.createDM();
    await dm.send({
      components: [buildTimeoutDmContainer(guild, moderator.user.tag, reason, minutes)],
      flags: V2_FLAGS,
    });
  } catch (e) {
    dmSent = false;
  }

  try {
    await member.timeout(minutes * 60 * 1000, `${reason} | by ${moderator.user.tag}`);
  } catch (e) {
    return { success: false, error: 'Failed to timeout this user: ' + e.message };
  }

  return { success: true, dmSent };
}

// ======================================================================
// READY
// ======================================================================
client.once('ready', () => {
  console.log(`Logged in as ${client.user.tag}`);
  client.user.setPresence({
    activities: [{ name: `${CONFIG.PREFIX}help | /say /ban /timeout` }],
    status: 'online',
  });
});

// ======================================================================
// SLASH COMMANDS
// ======================================================================
client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      const { commandName, member, guild } = interaction;

      // ---------------- /say ----------------
      if (commandName === 'say') {
        if (!hasSayPermission(member)) {
          return interaction.reply({
            components: [buildSimpleInfoContainer(CONFIG.DANGER_COLOR, 'Permission Denied', 'You need the **Manage Messages** permission to use this command.')],
            flags: V2_EPHEMERAL_FLAGS,
          });
        }
        const message = interaction.options.getString('message', true);
        const title = interaction.options.getString('title');
        const targetChannel = interaction.options.getChannel('channel') || interaction.channel;

        await targetChannel.send({
          components: [buildSayContainer(title, message)],
          flags: V2_FLAGS,
        });

        return interaction.reply({
          components: [buildSimpleInfoContainer(CONFIG.SUCCESS_COLOR, 'Sent', `Message sent to ${targetChannel}.`)],
          flags: V2_EPHEMERAL_FLAGS,
        });
      }

      // ---------------- /ban ----------------
      if (commandName === 'ban') {
        if (!hasBanPermission(member)) {
          return interaction.reply({
            components: [buildSimpleInfoContainer(CONFIG.DANGER_COLOR, 'Permission Denied', 'You need the **Ban Members** permission to use this command.')],
            flags: V2_EPHEMERAL_FLAGS,
          });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const targetUser = interaction.options.getUser('user', true);
        const days = interaction.options.getInteger('days', true);
        const reason = interaction.options.getString('reason') || 'No reason provided';

        const result = await performBan(guild, member, targetUser, days, reason);

        if (!result.success) {
          return interaction.editReply({
            components: [buildResultContainer(CONFIG.DANGER_COLOR, 'Ban Failed', result.error)],
            flags: V2_FLAGS,
          });
        }

        const lines = `**User:** ${targetUser.tag}\n**Duration:** ${days > 0 ? days + ' day(s)' : 'Permanent'}\n**Reason:** ${reason}\n**DM Sent:** ${result.dmSent ? 'Yes' : 'No (DMs closed)'}`;
        return interaction.editReply({
          components: [buildResultContainer(CONFIG.SUCCESS_COLOR, 'User Banned', lines)],
          flags: V2_FLAGS,
        });
      }

      // ---------------- /timeout ----------------
      if (commandName === 'timeout') {
        if (!hasTimeoutPermission(member)) {
          return interaction.reply({
            components: [buildSimpleInfoContainer(CONFIG.DANGER_COLOR, 'Permission Denied', 'You need the **Moderate Members** permission to use this command.')],
            flags: V2_EPHEMERAL_FLAGS,
          });
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const targetUser = interaction.options.getUser('user', true);
        const minutes = interaction.options.getInteger('duration', true);
        const reason = interaction.options.getString('reason') || 'No reason provided';

        const result = await performTimeout(guild, member, targetUser, minutes, reason);

        if (!result.success) {
          return interaction.editReply({
            components: [buildResultContainer(CONFIG.DANGER_COLOR, 'Timeout Failed', result.error)],
            flags: V2_FLAGS,
          });
        }

        const lines = `**User:** ${targetUser.tag}\n**Duration:** ${minutes} minute(s)\n**Reason:** ${reason}\n**DM Sent:** ${result.dmSent ? 'Yes' : 'No (DMs closed)'}`;
        return interaction.editReply({
          components: [buildResultContainer(CONFIG.SUCCESS_COLOR, 'User Timed Out', lines)],
          flags: V2_FLAGS,
        });
      }

      // ---------------- /ticket_panel_setup ----------------
      if (commandName === 'ticket_panel_setup') {
        if (!member.permissions.has(PermissionFlagsBits.ManageGuild)) {
          return interaction.reply({
            components: [buildSimpleInfoContainer(CONFIG.DANGER_COLOR, 'Permission Denied', 'You need the **Manage Server** permission to use this command.')],
            flags: V2_EPHEMERAL_FLAGS,
          });
        }
        const key = sessionKey(guild.id, member.id);
        setupSessions.set(key, {});
        return interaction.reply({
          components: [buildTicketSetupContainer({})],
          flags: V2_EPHEMERAL_FLAGS,
        });
      }
    }

    // ================== SETUP WIZARD: SELECT MENUS ==================
    if (interaction.isRoleSelectMenu() && interaction.customId === 'setup_staff_role') {
      const key = sessionKey(interaction.guild.id, interaction.user.id);
      const session = setupSessions.get(key) || {};
      session.staffRoleId = interaction.values[0];
      setupSessions.set(key, session);
      return interaction.update({ components: [buildTicketSetupContainer(session)], flags: V2_FLAGS });
    }

    if (interaction.isChannelSelectMenu() && interaction.customId === 'setup_ticket_category') {
      const key = sessionKey(interaction.guild.id, interaction.user.id);
      const session = setupSessions.get(key) || {};
      session.ticketCategoryId = interaction.values[0];
      setupSessions.set(key, session);
      return interaction.update({ components: [buildTicketSetupContainer(session)], flags: V2_FLAGS });
    }

    if (interaction.isChannelSelectMenu() && interaction.customId === 'setup_panel_channel') {
      const key = sessionKey(interaction.guild.id, interaction.user.id);
      const session = setupSessions.get(key) || {};
      session.panelChannelId = interaction.values[0];
      setupSessions.set(key, session);
      return interaction.update({ components: [buildTicketSetupContainer(session)], flags: V2_FLAGS });
    }

    // ================== BUTTON INTERACTIONS ==================
    if (interaction.isButton()) {
      const { customId, guild, member, channel, user } = interaction;

      // ---------------- Setup wizard: confirm ----------------
      if (customId === 'setup_confirm') {
        const key = sessionKey(guild.id, user.id);
        const session = setupSessions.get(key);
        if (!session || !session.staffRoleId || !session.ticketCategoryId || !session.panelChannelId) {
          return interaction.reply({
            components: [buildSimpleInfoContainer(CONFIG.DANGER_COLOR, 'Incomplete', 'Please select all options first.')],
            flags: V2_EPHEMERAL_FLAGS,
          });
        }
        const panelChannel = await guild.channels.fetch(session.panelChannelId).catch(() => null);
        if (!panelChannel) {
          return interaction.update({
            components: [buildSimpleInfoContainer(CONFIG.DANGER_COLOR, 'Error', 'Could not find the panel channel. Please try again.')],
            flags: V2_FLAGS,
          });
        }

        setGuildTicketConfig(guild.id, session);
        await panelChannel.send({
          components: [buildTicketPanelContainer(guild)],
          flags: V2_FLAGS,
        });
        setupSessions.delete(key);

        return interaction.update({
          components: [
            buildSimpleInfoContainer(
              CONFIG.SUCCESS_COLOR,
              'Setup Complete',
              `The ticket panel has been sent to ${panelChannel}.\n**Staff Role:** <@&${session.staffRoleId}>\n**Category:** <#${session.ticketCategoryId}>`
            ),
          ],
          flags: V2_FLAGS,
        });
      }

      // ---------------- Setup wizard: cancel ----------------
      if (customId === 'setup_cancel') {
        setupSessions.delete(sessionKey(guild.id, user.id));
        return interaction.update({
          components: [buildSimpleInfoContainer(CONFIG.WARN_COLOR, 'Cancelled', 'Ticket panel setup was cancelled.')],
          flags: V2_FLAGS,
        });
      }

      // ---------------- Create Ticket ----------------
      if (customId === 'create_ticket') {
        const ticketConfig = getGuildTicketConfig(guild.id);
        if (!ticketConfig) {
          return interaction.reply({
            components: [
              buildSimpleInfoContainer(
                CONFIG.DANGER_COLOR,
                'Not Configured',
                'The ticket system has not been set up yet. Ask an admin to run `/ticket_panel_setup`.'
              ),
            ],
            flags: V2_EPHEMERAL_FLAGS,
          });
        }

        const existing = guild.channels.cache.find(
          c => c.name === `ticket-${user.id}` && c.parentId === ticketConfig.ticketCategoryId
        );
        if (existing) {
          return interaction.reply({
            components: [buildSimpleInfoContainer(CONFIG.WARN_COLOR, 'Already Open', `You already have an open ticket: ${existing}`)],
            flags: V2_EPHEMERAL_FLAGS,
          });
        }

        const overwrites = [
          { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
          {
            id: user.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
          },
          {
            id: client.user.id,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels],
          },
          {
            id: ticketConfig.staffRoleId,
            allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
          },
        ];

        const ticketChannel = await guild.channels.create({
          name: `ticket-${user.id}`,
          type: ChannelType.GuildText,
          parent: ticketConfig.ticketCategoryId,
          topic: `Ticket for ${user.tag} (${user.id})`,
          permissionOverwrites: overwrites,
        });

        await ticketChannel.send({
          content: `<@&${ticketConfig.staffRoleId}> <@${user.id}>`,
          components: [buildTicketWelcomeContainer(user, guild)],
          flags: V2_FLAGS,
        });

        return interaction.reply({
          components: [buildSimpleInfoContainer(CONFIG.SUCCESS_COLOR, 'Ticket Created', `Your ticket has been created: ${ticketChannel}`)],
          flags: V2_EPHEMERAL_FLAGS,
        });
      }

      // ---------------- Claim Ticket ----------------
      if (customId === 'claim_ticket') {
        if (!isStaff(member)) {
          return interaction.reply({
            components: [buildSimpleInfoContainer(CONFIG.DANGER_COLOR, 'Denied', 'Only staff can claim tickets.')],
            flags: V2_EPHEMERAL_FLAGS,
          });
        }
        return interaction.reply({
          components: [buildSimpleInfoContainer(CONFIG.ACCENT_COLOR, 'Ticket Claimed', `${user} is now handling this ticket.`)],
          flags: V2_FLAGS,
        });
      }

      // ---------------- Close Ticket ----------------
      if (customId === 'close_ticket') {
        if (!isStaff(member) && channel.name !== `ticket-${user.id}`) {
          return interaction.reply({
            components: [buildSimpleInfoContainer(CONFIG.DANGER_COLOR, 'Denied', 'Only staff or the ticket owner can close this ticket.')],
            flags: V2_EPHEMERAL_FLAGS,
          });
        }
        await interaction.reply({
          components: [buildSimpleInfoContainer(CONFIG.WARN_COLOR, 'Closing Ticket', 'This channel will be deleted in 5 seconds.')],
          flags: V2_FLAGS,
        });
        setTimeout(() => channel.delete().catch(() => {}), 5000);
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (interaction.isRepliable()) {
      const payload = {
        components: [buildSimpleInfoContainer(CONFIG.DANGER_COLOR, 'Error', 'Something went wrong. Check the console log for details.')],
        flags: V2_EPHEMERAL_FLAGS,
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload).catch(() => {});
      } else {
        await interaction.reply(payload).catch(() => {});
      }
    }
  }
});

// ======================================================================
// PREFIX COMMANDS: +ban , +timeout
// ======================================================================
client.on('messageCreate', async message => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(CONFIG.PREFIX)) return;

  const args = message.content.slice(CONFIG.PREFIX.length).trim().split(/\s+/);
  const cmd = args.shift().toLowerCase();
  const guild = message.guild;
  const member = message.member;

  // ---------------- +ban ----------------
  if (cmd === 'ban') {
    if (!hasBanPermission(member)) {
      return message.reply({
        components: [buildSimpleInfoContainer(CONFIG.DANGER_COLOR, 'Permission Denied', 'You need the **Ban Members** permission to use this command.')],
        flags: V2_FLAGS,
      });
    }

    const userArg = args.shift();
    const daysArg = args.shift();
    const reason = args.join(' ') || 'No reason provided';

    if (!userArg || !daysArg || isNaN(parseInt(daysArg, 10))) {
      return message.reply({
        components: [buildSimpleInfoContainer(CONFIG.WARN_COLOR, 'Usage', `\`${CONFIG.PREFIX}ban @user/ID days reason\`\nExample: \`${CONFIG.PREFIX}ban @Someone 7 spamming\``)],
        flags: V2_FLAGS,
      });
    }

    const userId = userArg.replace(/[<@!>]/g, '');
    const targetUser = await client.users.fetch(userId).catch(() => null);
    if (!targetUser) {
      return message.reply({
        components: [buildSimpleInfoContainer(CONFIG.DANGER_COLOR, 'Not Found', 'Could not find that user.')],
        flags: V2_FLAGS,
      });
    }

    const days = Math.max(0, parseInt(daysArg, 10));
    const result = await performBan(guild, member, targetUser, days, reason);

    if (!result.success) {
      return message.reply({
        components: [buildResultContainer(CONFIG.DANGER_COLOR, 'Ban Failed', result.error)],
        flags: V2_FLAGS,
      });
    }
    const lines = `**User:** ${targetUser.tag}\n**Duration:** ${days > 0 ? days + ' day(s)' : 'Permanent'}\n**Reason:** ${reason}\n**DM Sent:** ${result.dmSent ? 'Yes' : 'No (DMs closed)'}`;
    return message.reply({
      components: [buildResultContainer(CONFIG.SUCCESS_COLOR, 'User Banned', lines)],
      flags: V2_FLAGS,
    });
  }

  // ---------------- +timeout ----------------
  if (cmd === 'timeout') {
    if (!hasTimeoutPermission(member)) {
      return message.reply({
        components: [buildSimpleInfoContainer(CONFIG.DANGER_COLOR, 'Permission Denied', 'You need the **Moderate Members** permission to use this command.')],
        flags: V2_FLAGS,
      });
    }

    const userArg = args.shift();
    const minutesArg = args.shift();
    const reason = args.join(' ') || 'No reason provided';

    if (!userArg || !minutesArg || isNaN(parseInt(minutesArg, 10))) {
      return message.reply({
        components: [buildSimpleInfoContainer(CONFIG.WARN_COLOR, 'Usage', `\`${CONFIG.PREFIX}timeout @user/ID minutes reason\`\nExample: \`${CONFIG.PREFIX}timeout @Someone 60 spamming\``)],
        flags: V2_FLAGS,
      });
    }

    const userId = userArg.replace(/[<@!>]/g, '');
    const targetUser = await client.users.fetch(userId).catch(() => null);
    if (!targetUser) {
      return message.reply({
        components: [buildSimpleInfoContainer(CONFIG.DANGER_COLOR, 'Not Found', 'Could not find that user.')],
        flags: V2_FLAGS,
      });
    }

    const minutes = Math.max(1, parseInt(minutesArg, 10));
    const result = await performTimeout(guild, member, targetUser, minutes, reason);

    if (!result.success) {
      return message.reply({
        components: [buildResultContainer(CONFIG.DANGER_COLOR, 'Timeout Failed', result.error)],
        flags: V2_FLAGS,
      });
    }
    const lines = `**User:** ${targetUser.tag}\n**Duration:** ${minutes} minute(s)\n**Reason:** ${reason}\n**DM Sent:** ${result.dmSent ? 'Yes' : 'No (DMs closed)'}`;
    return message.reply({
      components: [buildResultContainer(CONFIG.SUCCESS_COLOR, 'User Timed Out', lines)],
      flags: V2_FLAGS,
    });
  }
});

process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));

// ======================================================================
// Minimal HTTP server for Render Web Service deployments.
// Render requires an open port to keep a Web Service alive — this route
// only reports basic status and has no bot logic in it.
// ======================================================================
const http = require('http');
const PORT = process.env.PORT || 3000;

http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    const status = client.isReady() ? `Online as ${client.user.tag}` : 'Starting...';
    res.end(`${CONFIG.BRAND_NAME}\n${status}\nUptime: ${Math.floor(process.uptime())}s`);
  })
  .listen(PORT, () => console.log(`Health check server listening on port ${PORT}`));

client.login(process.env.TOKEN);
