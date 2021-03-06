/* global Actor, ChatMessage, CONFIG, CONST, game, ui, Roll, Dialog, mergeObject */

/**
 * Extend the base Actor entity by defining a custom roll data structure.
 * @extends {Actor}
 */
class DCCActor extends Actor {
  /** @override */
  prepareData () {
    super.prepareData()

    // Ability modifiers
    const abilities = this.data.data.abilities
    for (const abilityId in abilities) {
      abilities[abilityId].mod = CONFIG.DCC.abilities.modifiers[abilities[abilityId].value] || 0
    }

    // Get configuration data
    const config = this._getConfig()
    const data = this.data.data

    // Cap level if required
    if (config.capLevel) {
      data.details.level.value = Math.max(0, Math.min(data.details.level.value, parseInt(config.maxLevel)))
    }

    // Make sure items are initialised before computing any data derived from them
    if (!this.items) { return }

    // Compute AC if required
    if (config.computeAC) {
      const baseACAbility = data.abilities[config.baseACAbility] || { mod: 0 }
      const abilityMod = baseACAbility.mod
      let armorBonus = 0
      for (const armorItem of this.itemTypes.armor) {
        if (armorItem.data.data.equipped) {
          armorBonus += parseInt(armorItem.data.data.acBonus) || 0
        }
      }
      data.attributes.ac.value = 10 + abilityMod + armorBonus
    }

    // Determine the correct fumble die to use based on armor
    let fumbleDieRank = 0
    let fumbleDie = '1d4'
    if (this.itemTypes) {
      for (const armorItem of this.itemTypes.armor) {
        if (armorItem.data.data.equipped) {
          try {
            const expression = armorItem.data.data.fumbleDie
            const rank = game.dcc.DiceChain.rankDiceExpression(expression)
            if (rank > fumbleDieRank) {
              fumbleDieRank = rank
              fumbleDie = expression
            }
          } catch (err) {
            // Ignore bad fumble die expressions
          }
        }
      }
    }
    data.attributes.fumble = mergeObject(
      data.attributes.fumble || {},
      { die: fumbleDie }
    )

    // Gather available action dice
    try {
      // Implicit migration for legacy actors
      if (!this.data.data.config.actionDice) {
        this.data.data.config.actionDice = this.data.data.attributes.actionDice.value
      }
      // Parse the action dice expression from the config and produce a list of available dice
      const actionDieExpression = new Roll(this.data.data.config.actionDice || '1d20')
      actionDieExpression.roll()
      const terms = actionDieExpression.terms || actionDieExpression.parts
      const actionDice = []
      for (const term of terms) {
        if (typeof (term) === 'object') {
          const termDie = `1d${term.faces}`
          const termCount = term.number || 1
          for (let i = 0; i < termCount; ++i) {
            actionDice.push(termDie)
          }
        }
      }
      this.data.data.attributes.actionDice.options = actionDice
    } catch (err) { }
  }

  /**
   * Get per actor configuration
   *
   * @return {Object}       Configuration data
   */
  _getConfig () {
    let defaultConfig = {
      actionDice: '1d20',
      capLevel: false,
      maxLevel: 0,
      rollAttackBonus: false,
      computeAC: false,
      baseACAbility: 'agl',
      sortInventory: true,
      removeEmptyItems: true,
      showSpells: false,
      showSkills: false,
      showMaxAttributes: false,
      showBackstab: false
    }

    // Merge any existing data with defaults to implicitly migrate missing config fields
    defaultConfig = Object.assign(defaultConfig, this.data.data.config)
    this.data.data.config = defaultConfig

    return defaultConfig
  }

  /**
   * Roll an Ability Check
   * @param {String} abilityId    The ability ID (e.g. "str")
   * @param {Object} options      Options which configure how ability checks are rolled
   */
  rollAbilityCheck (abilityId, options = {}) {
    const ability = this.data.data.abilities[abilityId]
    ability.mod = CONFIG.DCC.abilities.modifiers[ability.value] || 0
    ability.label = CONFIG.DCC.abilities[abilityId]

    let roll

    // Allow requesting roll under (for Luck Checks)
    if (options.rollUnder) {
      roll = new Roll('1d20')

      // Apply custom roll options
      roll.roll()
      roll.dice[0].options.dcc = {
        rollUnder: true
      }
    } else {
      const die = this.data.data.attributes.actionDice.value
      roll = new Roll('@die+@abilMod', { die, abilMod: ability.mod, critical: 20 })
    }

    // Convert the roll to a chat message
    roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this }),
      flavor: `${game.i18n.localize(ability.label)} ${game.i18n.localize('DCC.Check')}`
    })
  }

  /**
   * Roll Initiative
   * @param {Object} token    The token to roll initiative for
   */
  async rollInitiative (token) {
    const die = this.data.data.attributes.init.die || '1d20'
    const init = this.data.data.attributes.init.value
    const roll = new Roll('@die+@init', { die, init })

    // Convert the roll to a chat message
    roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this }),
      flavor: game.i18n.localize('DCC.Initiative')
    })

    // Set initiative value in the combat tracker if there is an active combat
    if (token && game.combat) {
      const tokenId = token.id

      // Create or update combatant
      const combatant = game.combat.getCombatantByToken(tokenId)
      if (!combatant) {
        await game.combat.createCombatant({ tokenId, hasRolled: true, initiative: roll.total })
      } else {
        await game.combat.setInitiative(combatant._id, roll.total)
      }
    }
  }

  /**
   * Roll a Saving Throw
   * @param {String} saveId       The save ID (e.g. "ref")
   */
  rollSavingThrow (saveId) {
    const save = this.data.data.saves[saveId]
    const die = '1d20'
    save.label = CONFIG.DCC.saves[saveId]
    const roll = new Roll('@die+@saveMod', { die, saveMod: save.value })

    // Convert the roll to a chat message
    roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this }),
      flavor: `${game.i18n.localize(save.label)} ${game.i18n.localize('DCC.Save')}`
    })
  }

  /**
   * Roll a Skill Check
   * @param {String}  skillId       The skill ID (e.g. "sneakSilently")
   */
  rollSkillCheck (skillId) {
    let skill = this.data.data.skills ? this.data.data.skills[skillId] : null
    let skillItem = null
    if (!skill) {
      skillItem = this.itemTypes.skill.find(i => i.name === skillId)
      if (skillItem) {
        skill = {
          label: skillItem.name
        }
        if (skillItem.data.data.config.useAbility) {
          skill.ability = skillItem.data.data.ability
        }
        if (skillItem.data.data.config.useDie) {
          skill.die = skillItem.data.data.die
        }
        if (skillItem.data.data.config.useValue) {
          skill.value = skillItem.data.data.value
        }
      }
    }
    const die = skill.die || this.data.data.attributes.actionDice.value
    const ability = skill.ability || null
    var abilityLabel = ''
    if (ability) {
      abilityLabel = ` (${game.i18n.localize(CONFIG.DCC.abilities[ability])})`
    }

    var roll = null
    if (skill.value) {
      roll = new Roll(die + '+@bonus', { bonus: skill.value })
    } else {
      roll = new Roll(die)
    }
    roll.roll()

    // Handle special cleric spellchecks that are treated as skills
    if (skill.useDisapprovalRange) {
      if (roll.dice.length > 0) {
        roll.dice[0].options.dcc = {
          lowerThreshold: this.data.data.class.disapproval
        }
      }
    }

    // Convert the roll to a chat message
    roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this }),
      flavor: `${game.i18n.localize(skill.label)}${abilityLabel}`
    })

    // Store last result if required
    if (skillItem && skillItem.data.data.config.showLastResult) {
      skillItem.update({ 'data.lastResult': roll.total })
    }
  }

  /**
   * Roll the Luck Die
   */
  rollLuckDie () {
    const roll = new Roll(this.data.data.class.luckDie)

    // Convert the roll to a chat message
    roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this }),
      flavor: `${game.i18n.localize('DCC.LuckDie')}`
    })
  }

  /**
   * Roll a Spell Check
   * @param {String} abilityId       The ability used for the check (e.g. "per")
   */
  rollSpellCheck (options = {}) {
    if (!options.abilityId) {
      options.abilityId = this.data.data.class.spellCheckAbility || ''
    }

    // If a spell name is provided attempt to look up an item with that name for the roll
    if (options.spell) {
      const item = this.items.find(i => i.name === options.spell)
      if (item) {
        if (item.data.type === 'spell') {
          // Roll through the item and return so we don't also roll a basic spell check
          item.rollSpellCheck(options.abilityId)
          return
        } else {
          return ui.notifications.warn(game.i18n.localize('DCC.SpellCheckNonSpellWarning'))
        }
      } else {
        return ui.notifications.warn(game.i18n.localize('DCC.SpellCheckNoOwnedItemWarning'))
      }
    }

    // Otherwise fall back to a raw dice roll with appropriate flavor
    const ability = this.data.data.abilities[options.abilityId] || {}
    ability.label = CONFIG.DCC.abilities[options.abilityId]
    const spell = options.spell ? options.spell : game.i18n.localize('DCC.SpellCheck')
    const die = this.data.data.attributes.actionDice.value
    const bonus = this.data.data.class.spellCheck || '+0'
    const roll = new Roll('@die+@bonus', { die: die, bonus: bonus })
    roll.roll()

    if (roll.dice.length > 0) {
      roll.dice[0].options.dcc = {
        lowerThreshold: this.data.data.class.disapproval
      }
    }

    let flavor = spell
    if (ability.label) {
      flavor += ` (${game.i18n.localize(ability.label)})`
    }

    // Convert the roll to a chat message
    roll.toMessage({
      speaker: ChatMessage.getSpeaker({ actor: this }),
      flavor
    })
  }

  /**
   * Roll Attack Bonus
   */
  async rollAttackBonus (options) {
    /* Determine attack bonus */
    const attackBonusExpression = this.data.data.details.attackBonus || '0'

    if (attackBonusExpression) {
      const abRoll = new Roll(attackBonusExpression, { critical: 3 })

      // Store the result for use in attack and damage rolls
      const lastRoll = this.data.data.details.lastRolledAttackBonus = abRoll.roll().total
      this.update({
        'data.details.lastRolledAttackBonus': lastRoll
      })

      // Apply custom roll options
      if (abRoll.dice.length > 0) {
        abRoll.dice[0].options.dcc = {
          lowerThreshold: 2,
          upperThreshold: 3
        }
      }

      // Convert the roll to a chat message
      abRoll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor: this }),
        flavor: game.i18n.localize('DCC.DeedRoll')
      })
    }
  }

  /*
   * Set Action Dice
   */
  async setActionDice (die) {
    this.update({
      'data.attributes.actionDice.value': die
    })
  }

  /**
   * Roll a Weapon Attack
   * @param {string} weaponId     The weapon name or slot id (e.g. "m1", "r1")
   * @param {Object} options      Options which configure how ability tests are rolled
   */
  async rollWeaponAttack (weaponId, options = {}) {
    // Display standard cards in chat?
    let displayStandardCards = false
    try {
      displayStandardCards = game.settings.get('dcc', 'useStandardDiceRoller')
    } catch (err) { }

    // First try and find the item by name or id
    let weapon = this.items.find(i => i.name === weaponId || i._id === weaponId)
    const backstab = options.backstab

    // If not found try finding it by slot
    if (!weapon) {
      try {
        // Verify this is a valid slot name
        const result = weaponId.match(/^([mr])(\d+)$/)
        if (!result) {
          throw new Error('Invalid slot name')
        }
        const isMelee = weaponId[0] === 'm' // 'm' or 'r'
        const weaponIndex = parseInt(weaponId.slice(1)) - 1 // 1 based indexing
        let weapons = this.itemTypes.weapon
        if (this.data.data.config.sortInventory) {
          // ToDo: Move inventory classification and sorting into the actor so this isn't duplicating code in the sheet
          weapons = [...weapons].sort((a, b) => a.data.name.localeCompare(b.data.name))
        }
        weapon = weapons.filter(i => !!i.data.data.melee === isMelee)[weaponIndex]
      } catch (err) { }
    }

    // If all lookups fail, give up and show a warning
    if (!weapon) {
      return ui.notifications.warn(game.i18n.format('DCC.WeaponNotFound', { id: weaponId }))
    }

    /* Determine backstab bonus if used */
    let toHit = weapon.data.data.toHit
    if (backstab) {
      toHit = toHit + ' + ' + parseInt(this.data.data.class.backstab)
    }

    const speaker = { alias: this.name, _id: this._id }
    const formula = `${weapon.data.data.actionDie} + ${toHit}`
    const config = this._getConfig()

    /* Determine attack bonus */
    let attackBonus = 0
    if (config.rollAttackBonus) {
      attackBonus = this.data.data.details.lastRolledAttackBonus || 0
    }

    /* Determine crit range */
    const critRange = weapon.data.data.critRange || this.data.data.details.critRange || 20

    /* Roll the Attack */
    const roll = new Roll(formula, { ab: attackBonus, critical: critRange })
    roll.roll()
    const d20RollResult = roll.dice[0].total

    if (displayStandardCards) {
      roll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor: this }),
        flavor: game.i18n.localize('DCC.AttackRoll')
      })
    }

    /* Handle Critical Hits and fumbles */
    const crit = (d20RollResult > 1 && (d20RollResult >= critRange || backstab)) ? await this.rollCritical() : ''
    const fumble = (d20RollResult === 1) ? await this.rollFumble() : ''

    /* Roll the Damage */
    let damageFormula = weapon.data.data.damage
    if (backstab && weapon.data.data.backstab) {
      damageFormula = weapon.data.data.backstabDamage
    }
    const damageRoll = new Roll(damageFormula, { ab: attackBonus })
    damageRoll.roll()

    if (displayStandardCards) {
      damageRoll.toMessage({
        speaker: ChatMessage.getSpeaker({ actor: this }),
        flavor: game.i18n.localize(backstab ? 'DCC.Backstab' : 'DCC.DamageRoll')
      })
    }

    /* Emote attack results */
    if (!displayStandardCards) {
      // TODO: Remove call to roll.parts - it's deprecated in favour of roll.terms, but is required for backwards compatibility
      const attackRollHTML = this._formatRoll(roll, Roll.cleanFormula(roll.terms || roll.formula))
      const damageRollData = escape(JSON.stringify(damageRoll))
      const damageRollTotal = damageRoll.total
      const damageRollHTML = `<a class="inline-roll inline-result damage-applyable" data-roll="${damageRollData}" data-damage="${damageRollTotal}" title="${Roll.cleanFormula(damageRoll.terms || damageRoll.formula)}"><i class="fas fa-dice-d20"></i> ${damageRollTotal}</a>`

      const emote = backstab ? 'DCC.BackstabEmote' : 'DCC.AttackRollEmote'
      const messageData = {
        user: game.user._id,
        speaker: speaker,
        type: CONST.CHAT_MESSAGE_TYPES.EMOTE,
        content: game.i18n.format(emote, {
          weaponName: weapon.name,
          rollHTML: attackRollHTML,
          damageRollHTML: damageRollHTML,
          crit: crit,
          fumble: fumble
        }),
        sound: CONFIG.sounds.dice
      }
      await CONFIG.ChatMessage.entityClass.create(messageData)
    }
  }

  /**
   * Roll a Critical Hit
   */
  async rollCritical () {
    // Display standard cards in chat?
    const displayStandardCards = game.settings.get('dcc', 'useStandardDiceRoller')

    // Roll the crit
    const roll = new Roll(`${this.data.data.attributes.critical.die} + ${this.data.data.abilities.lck.mod}`)
    roll.roll()
    const rollData = escape(JSON.stringify(roll))
    const rollTotal = roll.total
    const rollHTML = `<a class="inline-roll inline-result" data-roll="${rollData}" data-damage="${rollTotal}" title="${Roll.cleanFormula(roll.terms || roll.formula)}"><i class="fas fa-dice-d20"></i> ${rollTotal}</a>`

    // Lookup the crit table if available
    let critResult = null
    const critsPackName = game.settings.get('dcc', 'critsCompendium')
    if (critsPackName) {
      const pack = game.packs.get(critsPackName)
      if (pack) {
        await pack.getIndex() // Load the compendium index
        const critTableFilter = `Crit Table ${this.data.data.attributes.critical.table}`
        const entry = pack.index.find((entity) => entity.name.startsWith(critTableFilter))
        if (entry) {
          const table = await pack.getEntity(entry._id)
          critResult = await table.draw({ roll, displayChat: displayStandardCards })
        }
      }
    }

    if (!displayStandardCards) {
      // Display crit result or just a notification of the crit
      if (critResult) {
        return ` <br/><br/><span style='color:#ff0000; font-weight: bolder'>${game.i18n.localize('DCC.CriticalHit')}!</span> ${rollHTML}<br/>${critResult.results[0].text}`
      } else {
        return ` <br/><br/><span style='color:#ff0000; font-weight: bolder'>${game.i18n.localize('DCC.CriticalHit')}!</span> ${rollHTML}`
      }
    }
  }

  /**
   * Roll a Fumble
   */
  async rollFumble () {
    // Display standard cards in chat?
    const displayStandardCards = game.settings.get('dcc', 'useStandardDiceRoller')

    let fumbleDie
    try {
      fumbleDie = this.data.data.attributes.fumble.die
    } catch (err) {
      fumbleDie = '1d4'
    }

    // Roll the fumble
    const roll = new Roll(`${fumbleDie} - ${this.data.data.abilities.lck.mod}`)
    roll.roll()
    const rollData = escape(JSON.stringify(roll))
    const rollTotal = roll.total
    const rollHTML = `<a class="inline-roll inline-result" data-roll="${rollData}" data-damage="${rollTotal}" title="${Roll.cleanFormula(roll.terms || roll.formula)}"><i class="fas fa-dice-d20"></i> ${rollTotal}</a>`

    // Lookup the fumble table if available
    let fumbleResult = null
    const fumbleTableName = game.settings.get('dcc', 'fumbleTable')
    if (fumbleTableName) {
      const fumbleTablePath = fumbleTableName.split('.')
      let pack
      if (fumbleTablePath.length === 3) {
        pack = game.packs.get(fumbleTablePath[0] + '.' + fumbleTablePath[1])
      }
      if (pack) {
        await pack.getIndex() // Load the compendium index
        const entry = pack.index.find((entity) => entity.name === fumbleTablePath[2])
        if (entry) {
          const table = await pack.getEntity(entry._id)
          fumbleResult = await table.draw({ roll, displayChat: displayStandardCards })
        }
      }
    }

    if (!displayStandardCards) {
      // Display fumble result or just a notification of the fumble
      if (fumbleResult) {
        return ` <br/><br/><span style='color:red; font-weight: bolder'>Fumble!</span> ${rollHTML}<br/>${fumbleResult.results[0].text}`
      } else {
        return ` <br/><br/><span style='color:red; font-weight: bolder'>Fumble!</span> ${rollHTML}`
      }
    }
  }

  /**
   * Format a roll for display in-line
   * @param {Object<Roll>} roll   The roll to format
   * @param {string} formula      Formula to show when hovering
   * @return {string}             Formatted HTML containing roll
   */
  _formatRoll (roll, formula) {
    const rollData = escape(JSON.stringify(roll))

    // Check for Crit/Fumble
    let critFailClass = ''
    if (Number(roll.dice[0].results[0]) === 20) { critFailClass = 'critical ' } else if (Number(roll.dice[0].results[0]) === 1) { critFailClass = 'fumble ' }
    return `<a class="${critFailClass}inline-roll inline-result" data-roll="${rollData}" title="${formula}"><i class="fas fa-dice-d20"></i> ${roll.total}</a>`
  }

  /**
   * Apply damage to this actor
   * @param {Number} damageAmount   Damage amount to apply
   * @param {Number} multiplier     Damage multiplier
   */
  async applyDamage (damageAmount, multiplier) {
    const speaker = { alias: this.name, _id: this._id }

    // Calculate damage amount and current hit points
    const amount = damageAmount * multiplier
    const hp = this.data.data.attributes.hp.value

    let newHp = hp
    if (amount > 0) {
      // Taking damage - just subtract and allow damage to go below zero
      newHp = newHp - amount
    } else {
      // Healing - don't allow HP to be brought above MaxHP, but if it's already there assume it's intentional
      const maxHp = this.data.data.attributes.hp.max
      if (hp >= maxHp) {
        newHp = hp
      } else {
        newHp = Math.min(newHp - amount, maxHp)
      }
    }

    const deltaHp = newHp - hp

    // Announce damage or healing results
    if (Math.abs(deltaHp) > 0) {
      const locstring = (deltaHp > 0) ? 'DCC.HealDamage' : 'DCC.TakeDamage'
      const messageData = {
        user: game.user._id,
        speaker: speaker,
        type: CONST.CHAT_MESSAGE_TYPES.EMOTE,
        content: game.i18n.format(locstring, { target: this.name, damage: Math.abs(deltaHp) }),
        sound: CONFIG.sounds.notification
      }
      await CONFIG.ChatMessage.entityClass.create(messageData)
    }

    // Apply new HP
    return this.update({
      'data.attributes.hp.value': newHp
    })
  }

  /**
   * Apply a point of disapproval
   */
  applyDisapproval () {
    this.update({
      'data.class.disapproval': this.data.data.class.disapproval + 1
    })
  }

  /**
   * Prompt and roll for disapproval
   */
  async rollDisapproval () {
    const html = `<form id="disapproval-formula-form">
                    <label for="formula">${game.i18n.localize('DCC.DisapprovalRollFormula')}</label>
                    <input type="text" name="formula" placeholder="1d4 - luck modifier" value="1d4 - ${this.data.data.abilities.lck.mod}"/>
                  </form>`
    new Dialog({
      title: game.i18n.localize('DCC.DisapprovalRollFormula'),
      content: html,
      buttons: {
        yes: {
          icon: '<i class="fas fa-check"></i>',
          label: 'Roll Disapproval',
          callback: html => this._onRollDisapproval(html)
        },
        no: {
          icon: '<i class="fas fa-times"></i>',
          label: 'Cancel'
        }
      }
    }).render(true)
  }

  /**
   * Roll disapproval
   * @param {Object} disapprovalRollHTML  form with disapproval formula input
   * @private
   */
  async _onRollDisapproval (disapprovalRollHTML) {
    const formula = disapprovalRollHTML[0].querySelector('#disapproval-formula-form')[0].value

    try {
      const roll = new Roll(formula)

      // Lookup the disapproval table if available
      let disapprovalTable = null
      const disapprovalPackName = game.settings.get('dcc', 'disapprovalCompendium')
      const disapprovalTableName = this.data.data.class.disapprovalTable
      if (disapprovalPackName && disapprovalTableName) {
        const pack = game.packs.get(disapprovalPackName)
        if (pack) {
          await pack.getIndex() // Load the compendium index
          const entry = pack.index.find((entity) => entity.name === disapprovalTableName)
          if (entry) {
            disapprovalTable = await pack.getEntity(entry._id)
          }
        }
      }

      // Draw from the table if found, otherwise display the roll
      if (disapprovalTable) {
        const results = disapprovalTable.roll({ roll })
        disapprovalTable.draw(results)
      } else {
        // Fall back to displaying just the roll
        roll.toMessage({
          speaker: ChatMessage.getSpeaker({ actor: this }),
          flavor: game.i18n.localize('DCC.DisapprovalRoll')
        })
      }
    } catch (err) {
      ui.notifications.warn(game.i18n.format('DCC.DisapprovalFormulaWarning', { formula }))
    }
  }
}

export default DCCActor
