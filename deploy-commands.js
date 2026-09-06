require('dotenv').config();
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');

const commands = [
  new SlashCommandBuilder()
    .setName('say')
    .setDescription('Send a branded message to a channel')
    .addStringOption(opt =>
      opt.setName('message').setDescription('The message to send').setRequired(true)
    )
    .addChannelOption(opt =>
      opt
        .setName('channel')
        .setDescription('Channel to send to (defaults to this channel)')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false)
    )
    .addStringOption(opt =>
      opt.setName('title').setDescription('Optional title for the message').setRequired(false)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('ban')
    .setDescription('Ban a user and notify them by DM')
    .addUserOption(opt => opt.setName('user').setDescription('User to ban').setRequired(true))
    .addIntegerOption(opt =>
      opt
        .setName('days')
        .setDescription('Ban duration in days (0 = permanent)')
        .setMinValue(0)
        .setMaxValue(30)
        .setRequired(true)
    )
    .addStringOption(opt => opt.setName('reason').setDescription('Reason for the ban').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('timeout')
    .setDescription('Timeout a user and notify them by DM')
    .addUserOption(opt => opt.setName('user').setDescription('User to timeout').setRequired(true))
    .addIntegerOption(opt =>
      opt
        .setName('duration')
        .setDescription('Timeout duration in minutes')
        .setMinValue(1)
        .setMaxValue(40320)
        .setRequired(true)
    )
    .addStringOption(opt => opt.setName('reason').setDescription('Reason for the timeout').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
    .toJSON(),

  new SlashCommandBuilder()
    .setName('ticket_panel_setup')
    .setDescription('Configure the ticket system (staff role, category, panel channel)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),
];

const rest = new REST().setToken(process.env.TOKEN);

(async () => {
  try {
    console.log(`Deploying ${commands.length} slash command(s)...`);

    if (process.env.GUILD_ID) {
      await rest.put(
        Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
        { body: commands }
      );
      console.log('Guild commands deployed to GUILD_ID.');
    } else {
      await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands });
      console.log('Global commands deployed (may take up to 1 hour to appear).');
    }
  } catch (error) {
    console.error('Failed to deploy commands:', error);
  }
})();
