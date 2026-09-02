# What is this module?

A module dedicated to Daggerheart, it enables the Gamemaster (GM) to configure ‘Features’ as Feats, therefore allowing Player Characters (PCs) to select these following a configurable set of rules.

# What are Feats?

Feats are additional abilities untied to any Daggerheart Domain (such as Bone or Codex). Instead, they have the following attributes:

1. **Category:** A Feat has a single Category, usually tying them to a Family of Feats (e.g.: Alchemy, Swordmaster, etc).  
2. **Level:** The Level of a given Feat is both an indicator for its power budget, as well as a hard requirement (see entry below) for any PCs that would like to acquire it.  
3. **Further Requirements:** A Feat may have additional requirements, as follow:  
   1. **Resources:** A given value of Hit Points, Stress, Evasion or Hope.  
   2. **Traits:** Requiring at least a given value in a given Trait.  
   3. **Other Feats or Features:** Requiring specific Feats (or any Feature) to already be acquired by the PC.  
   4. **Class or Subclass:** Requiring the PC to have a given Class or Subclass.  
   5. **Investment in Category:** Requiring the PC to have a given Value of already acquired Feats in the given Categories.  
4. **Type:** A Feat always has at least one type, but may carry multiple. Default types are as below, but the GM may add more Types in the Module Settings, if so desired.  
   1. Category (automatically carried from the Category attribute)  
   2. General  
   3. Combat  
   4. Spellcasting  
   5. Utility  
   6. Social  
   7. Crafting  
   8. Downtime  
   9. Class (As in, the name of a Class, such as Rogue)  
   10. Domain (As in, the name of a Domain, such as Codex)

# How do I gain Feats?

By default, PCs will gain 2 Feat Points per Character Level. This is configurable in the Module Settings, accepting expressions such as (level \* 2).

While a PC has unspent Feat Points, a module badge next to their Level within their Character Sheet will faintly glow, indicating they may spend Feat Points.

When clicked, the badge will open a catalog of Feats, which is setup as a list, heavily inspired by the Pathfinder 2e system. On the left hand side, a list of toggle and filters help the given user to filter for the Feats they are looking for, such as filtering by type or a given level range. On the right side, they will see a listing of all the Feats (filtered, if filters are configured), showing their icons, their Feat names, requirements and a short description. If clicked, they expand to show their full description.

Should a PC decide to acquire a said Feat, they may either click on the “+” sign, which will open a dialog, either:

1. Asking if they want to spend a Feat Point for this Feat, and warning them that they may not reverse this without GM intervention.  
2. Or, warning them that they do not qualify (either due to Requirements or not having Feat Points left)

# How does the GM set up Feats?

A GM has fundamentally two options, both living in the Module Settings.

1. Add an entire Compedium to the module, allowing it to read all given Features within it as Feats.  
2. Drag any singular Feature from the Item Sections, transforming it into a Feat.

