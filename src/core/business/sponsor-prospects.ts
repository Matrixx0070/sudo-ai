/**
 * Curated brand prospect catalogue for the SponsorManager.
 * Keyed by content niche / vertical (lowercase).
 */

export const NICHE_PROSPECTS: Record<string, string[]> = {
  tech: ['NordVPN', 'Surfshark', 'ExpressVPN', 'Hostinger', 'Bluehost', 'Squarespace', 'Wix', 'Canva', 'Notion', 'Grammarly'],
  gaming: ['Razer', 'SteelSeries', 'Corsair', 'G-Fuel', 'ASTRO Gaming', 'HyperX', 'Logitech G', 'Secretlab', 'Elgato', 'Seagate'],
  finance: ['Wise', 'Revolut', 'Robinhood', 'Webull', 'Public.com', 'CoinLedger', 'TaxBit', 'Credit Karma', 'NerdWallet', 'Personal Capital'],
  health: ['Athletic Greens', 'Hims', 'Hers', 'Noom', 'BetterHelp', 'Calm', 'Headspace', 'Ritual Vitamins', 'Care/of', 'Thrive Market'],
  education: ['Skillshare', 'Coursera', 'Brilliant.org', 'Duolingo', 'MasterClass', 'LinkedIn Learning', 'Udemy', 'Codecademy', 'CuriosityStream', 'Wondrium'],
  ai: ['Jasper', 'Copy.ai', 'Writesonic', 'Descript', 'Murf AI', 'Synthesia', 'Pictory', 'Opus Clip', 'HeyGen', 'ElevenLabs'],
  ecommerce: ['Shopify', 'BigCommerce', 'WooCommerce', 'Gumroad', 'Selz', 'Printful', 'Printify', 'Dropified', 'Spocket', 'Etsy'],
  entertainment: ['Epidemic Sound', 'Artlist', 'Musicbed', 'Envato Elements', 'Motion Array', 'Storyblocks', 'Pond5', 'Shutterstock', 'Adobe Creative Cloud', 'Splice'],
  youtube: ['TubeBuddy', 'VidIQ', 'Epidemic Sound', 'Artlist', 'Canva Pro', 'Envato Elements', 'Streamlabs', 'Ecamm Live', 'StreamYard', 'Morningfa.me'],
  software: ['1Password', 'LastPass', 'Dashlane', 'Keeper', 'NordPass', 'CleanMyMac', 'Setapp', 'Parallels', 'TextExpander', 'DEVONthink'],
};

/** Generic fallback list for unrecognised niches. */
export const FALLBACK_PROSPECTS: string[] = [
  'NordVPN', 'Surfshark', 'Canva', 'Skillshare', 'Brilliant.org',
  'Squarespace', 'Epidemic Sound', 'Hostinger', 'Notion', 'Grammarly',
];
