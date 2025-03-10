const debug = require('debug')('bedrock-portal');
const { v4: uuidV4 } = require('uuid');
const { XboxRTA } = require('xbox-rta');
const { EventEmitter } = require('events');

const { altCheck } = require('./common/util');
const { version: pkgVersion } = require('../package.json');
const { SessionConfig, Endpoints, Joinability } = require('./common/constants');

const Rest = require('./rest');
const Player = require('./classes/Player');

const genRaknetGUID = () => {
  const chars = '0123456789';
  let result = '';
  for (let i = 20; i > 0; --i) result += chars[Math.floor(Math.random() * chars.length)];
  return result;
};

module.exports = class BedrockPortal extends EventEmitter {
  #rest;#rta;
  constructor(authflow, options = {}) {
    super();
    this.options = {
      port: 19132,
      disableAltCheck: false,
      joinability: 'friends_of_friends',
      ...options,
      world: {
        hostName: `Bedrock Portal v${pkgVersion}`,
        name: 'By LucienHH',
        version: pkgVersion,
        memberCount: 0,
        maxMemberCount: 10,
        ...options.world,
      },
    };
    this.validateOptions(this.options);
    this.#rest = new Rest(authflow);
    this.#rta = new XboxRTA(authflow);
    const uuid = uuidV4();
    this.session = {
      url: `https://sessiondirectory.xboxlive.com/serviceconfigs/${SessionConfig.MinecraftSCID}/sessionTemplates/${SessionConfig.MinecraftTemplateName}/sessions/${uuid}`,
      name: uuid,
      subscriptionId: uuidV4(),
    };
    this.players = [];
  }

  validateOptions(options) {
    if (!options.ip) throw new Error('No IP provided');
    if (!options.port) throw new Error('No port provided');
    if (!Object.keys(Joinability).includes(options.joinability)) throw new Error('Invalid joinability - Expected one of ' + Object.keys(Joinability).join(', '));
  }

  async start() {
    this.sessionOwner = await this.#rest.getXboxProfile('me');

    if (!this.options.disableAltCheck) {
      const { isAlt, reason } = await altCheck(this.#rest);
      if (!isAlt) throw new Error('Genuine account detected - ' + reason);
    }

    await this.#rta.connect();

    const connectionId = await this.#rta.subscribe('https://sessiondirectory.xboxlive.com/connections/').then(e => e.data.ConnectionId);

    const session = await this.#createAndPublishSession(connectionId);

    await this.#handleSessionEvents();

    this.emit('sessionCreated', session);

    return session;
  }

  async end() {
    await this.#rta.disconnect();

    await this.updateSession({ members: { me: null } });

    if (this.modules) {
      for (const mod of Object.values(this.modules)) {
        mod.stop();
      }
    }
    debug(`Abandoned session, name: ${this.session.name}`);
  }

  getSessionMembers() {
    return this.players;
  }

  async invitePlayer(identifier) {
    debug(`Inviting player, identifier: ${identifier}`);

    const profile = await this.#rest.getXboxProfile(identifier)
      .catch(() => { throw new Error(`Failed to get profile for identifier: ${identifier}`); });

    debug(`Inviting player, Got profile, xuid: ${profile.xuid}`);

    const invitePayload = {
      invitedXuid: String(profile.xuid),
      inviteAttributes: { titleId: SessionConfig.MinecraftTitleID },
    };

    await this.updateHandle(this.#createHandleBody('invite', invitePayload));

    debug(`Invited player, xuid: ${profile.xuid}`);
  }

  async updateMemberCount(count) {
    await this.updateSession({ properties: { custom: { MemberCount: Number(count) } } });
  }

  async updateConnection(connectionId) {
    await this.updateSession({
      members: {
        me: {
          properties: {
            system: {
              active: true,
              connection: connectionId,
            },
          },
        },
      },
    });
  }

  async getSession() {
    return await this.#rest.get(this.session.url, {
      contractVersion: 107,
    });
  }

  async updateSession(payload) {
    await this.#rest.put(this.session.url, {
      data: { ...payload },
      contractVersion: 107,
    });
  }

  async updateHandle(payload) {
    await this.#rest.post(Endpoints.Handle, {
      data: { ...payload },
      contractVersion: 107,
    });
  }

  use(module, options = {}) {

    debug(`Enabled module: ${module.name} with options: ${JSON.stringify(options)}`);

    this.modules = this.modules || {};

    if (typeof module === 'function') module = new module();
    if (!(module instanceof require('./classes/Module'))) throw new Error('Module must extend the base module');
    if (typeof module.run !== 'function') throw new Error('Module must have a run function');
    if (this.modules[module.name]) throw new Error(`Module with name ${module.name} has already been loaded`);

    module.applyOptions(options);

    this.modules[module.name] = module;
  }

  async #createAndPublishSession(connectionId) {
    this.players = [];

    await this.updateSession(this.#createSessionBody(connectionId));

    debug(`Created session, name: ${this.session.name}`);

    await this.updateHandle(this.#createHandleBody('activity'));

    const session = await this.getSession();

    await this.updateSession({ properties: session.properties });

    debug(`Published session, name: ${this.session.name}`);

    return session;
  }

  async #handleSessionEvents() {
    this.#rta.on('reconnect', async () => {
      const connectionId = await this.#rta.subscribe('https://sessiondirectory.xboxlive.com/connections/').then(e => e.data.ConnectionId);

      try {
        await this.updateConnection(connectionId);
        await this.updateHandle(this.#createHandleBody('activity'));
      }
      catch (e) {
        debug('Failed to update connection, session may have been abandoned', e);
        await this.createAndPublishSession(connectionId);
      }
    });

    this.#rta.on('event', async ({ type, subId, data }) => {
      this.emit('rtaEvent', { type, subId, data });
      const session = await this.getSession();

      this.emit('sessionUpdated', session);

      debug('Received RTA event, session has been updated', session);

      const sessionMembers = Object.keys(session.members).map(key => session.members[key]).filter(member => member.constants.system.xuid !== this.sessionOwner.xuid);
      const xuids = sessionMembers.map(e => e.constants.system.xuid);

      const profiles = await this.#rest.getxboxProfileBatch(xuids);

      const players = sessionMembers.map(sessionMember => {
        const player = profiles.find(p => p.xuid === sessionMember.constants.system.xuid);
        return new Player(player, sessionMember);
      });

      const newPlayers = players.filter(player => !this.players.find(p => p.profile.xuid === player.profile.xuid));
      if (newPlayers.length) newPlayers.forEach(player => this.emit('playerJoin', player));

      const removedPlayers = this.players.filter(player => !players.find(p => p.profile.xuid === player.profile.xuid));
      if (removedPlayers.length) removedPlayers.forEach(player => this.emit('playerLeave', player));

      this.players = players;
    });

    if (this.modules) {
      Object.values(this.modules).forEach(async mod => {
        try {
          mod.run(this, { rest: this.#rest, rta: this.#rta });
          debug(`Module ${mod.name} has run`);
        }
        catch (e) {
          debug(`Module ${mod.name} failed to run`, e);
        }
      });
    }

  }

  #createHandleBody(type, additional = {}) {
    return {
      version: 1,
      type,
      sessionRef: {
        scid: SessionConfig.MinecraftSCID,
        templateName: SessionConfig.MinecraftTemplateName,
        name: this.session.name,
      },
      ...additional,
    };
  }

  #createSessionBody(connectionId) {
    const joinability = Joinability[this.options.joinability];
    return {
      properties: {
        system: {
          joinRestriction: joinability.joinRestriction,
          readRestriction: 'followed',
          closed: false,
        },
        custom: {
          hostName: String(this.options.world.hostName),
          worldName: String(this.options.world.name),
          version: String(this.options.world.version),
          MemberCount: Number(this.options.world.memberCount),
          MaxMemberCount: Number(this.options.world.maxMemberCount),
          Joinability: joinability.joinability,
          ownerId: this.sessionOwner.xuid,
          rakNetGUID: genRaknetGUID(),
          worldType: 'Survival',
          protocol: SessionConfig.MiencraftProtocolVersion,
          BroadcastSetting: joinability.broadcastSetting,
          OnlineCrossPlatformGame: true,
          CrossPlayDisabled: false,
          TitleId: 0,
          TransportLayer: 0,
          SupportedConnections: [
            {
              ConnectionType: 6,
              HostIpAddress: this.options.ip,
              HostPort: Number(this.options.port),
              RakNetGUID: '',
            },
          ],
        },
      },
      members: {
        me: {
          constants: {
            system: {
              xuid: this.sessionOwner.xuid,
              initialize: true,
            },
          },
          properties: {
            system: {
              active: true,
              connection: connectionId,
              subscription: {
                id: this.session.subscriptionId,
                changeTypes: ['everything'],
              },
            },
          },
        },
      },
    };
  }
};
