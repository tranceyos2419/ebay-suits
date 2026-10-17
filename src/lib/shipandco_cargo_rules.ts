/**
 * shipandco_cargo_rules.ts -- the 貨物内容 (cargo contents) rules from the
 * /shipandco-filling-up skill (see shipandco-cargo-contents-rules.md):
 * item name, HS code + 内容物 description, and 原産国, per store.
 *
 *   jdm-direct-motors (tranceyos2419): titles are reviewed by Claude and end in
 *     " No battery" (<= 80 bytes); HS code from hs2419 (US/PR/VI -> 8409911080).
 *   love-of-japan (tranceyos2316): titles unchanged; HS code from hs2316.
 *   Both: 原産国 JP.
 *
 * Title cleanup is a judgement call (keep brand + part description, strip
 * Genuine/OEM/JDM/Japan, models, years, part numbers), so it is not automated:
 * reviewed names are passed in, and a jdm-direct-motors title without one is
 * reported as needing review.
 */

/** 設定 -> 内容物リスト descriptions, as registered in Ship&Co. */
export const HS_DESCRIPTIONS: Record<string, string> = {
  "8409911080": "US - Motors",
  "8511501100": "Auto Parts - Ignition Starter",
  "8708291500": "Auto Parts - Body",
  "8708305030": "Auto Parts - Brake Clutch",
  "8708407000": "Auto Parts - Drivetrain",
  "8708917000": "Auto Parts - Exhaust",
  "8708947000": "Auto Parts - Steering",
  "8708995500": "Auto Parts",
  "8471602000": "Computer Keyboard Mouse",
  "8517130000": "Smartphone",
  "8517620090": "Electronic Device",
  "8518298000": "Loudspeaker",
  "8518302000": "Headphones",
  "8519813010": "Audio Player",
  "8525810000": "Digital Camera",
  "9002116000": "Camera Lens",
  "9102110000": "Wristwatch",
  "9205904020": "Clarinet",
  "9205904060": "Flute",
  "9207100010": "Electronic Keyboard Instrument",
  "9503000090": "Toys and Figures",
  "9504500000": "Video Game Console",
  "9506310000": "Golf Clubs",
  "9506390060": "Golf Equipment",
};

export type Store = "jdm-direct-motors" | "love-of-japan";

/** The title with filler words, major car makers and years removed (used only for HS matching). */
function cleanName(name: string): string {
  return name
    .replace(/\b(for|fit|fits|oem|jdm|genuine|new|used|japan|replacement)\b/gi, "")
    .replace(/\b(toyota|honda|nissan|mazda|subaru|mitsubishi|lexus|acura|infiniti)\b/gi, "")
    .replace(/\b(\d{4}[-–]\d{4}|\d{4})\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** tranceyos2419 (jdm-direct-motors) HS code. */
export function hs2419(name: string, country: string): string {
  const n = cleanName(name).toLowerCase();
  if (/^(us|pr|vi)$/i.test(country.trim())) return "8409911080";
  if (/exhaust|manifold/.test(n)) return "8708917000";
  if (/alternator|ignition|spark|starter/.test(n)) return "8511501100";
  if (/engine|pump|fuel|injector|piston/.test(n)) return "8409911080";
  if (/steer|rack|pinion|tie rod/.test(n)) return "8708947000";
  if (/brake|caliper|rotor|clutch|pad/.test(n)) return "8708305030";
  if (/transmission|gearbox|axle|driveshaft/.test(n)) return "8708407000";
  if (/door|lock|handle|mirror|bumper|fender|hood|body/.test(n)) return "8708291500";
  return "8708995500";
}

/** tranceyos2316 (love-of-japan) HS code: first matching keyword rule wins. */
const HS2316: [RegExp, string][] = [
  [/\b(trading card|pokemon|yugioh|yu-gi-oh|magic the gathering|mtg|tcg|booster pack|card game)\b/, "9504400000"],
  [/\b(sim.?free|sim unlock|sim-unlock|unlocked phone|android phone|mobile phone|cell phone|smartphone)\b/, "8517130000"],
  [/\bxperia\b/, "8517130000"],
  [/\bgalaxy\s*(s|a|note|z|fe)\s*\d/, "8517130000"],
  [/\biphone\s*\d/, "8517130000"],
  [/\b(nintendo switch|3ds|dsi|ds lite|wii u|wii|famicom|super famicom|sfc|gameboy|game boy)\b/, "9504500000"],
  [/\b(playstation|ps vita|psvita|ps\s?[2345]|psp|ps one|psone)\b/, "9504500000"],
  [/\b(xbox|mega drive|genesis|sega saturn|dreamcast|neo geo|atari)\b/, "9504500000"],
  [/\b(game console|handheld console|handheld game|gaming console|video game console)\b/, "9504500000"],
  [/\b(gamepad|controller|joycon|joy.con)\b/, "9504500000"],
  [/\b(1\/144|1\/100|1\/72|1\/60|1\/48|1\/35|1\/24|1\/12)\b/, "9503000090"],
  [/\b(figure|figurine|action figure|scale figure|statue|bust|diorama)\b/, "9503000090"],
  [/\b(plastic model|model kit|assembly kit|garage kit|gunpla|nendoroid|figma)\b/, "9503000090"],
  [/\b(toy|doll|lego|playset)\b/, "9503000090"],
  [/\b(headphone|earphone|earbuds|earbud|in-ear|over-ear|on-ear|open-air|open back|closed back)\b/, "8518302000"],
  [/\b(noise.cancel|anc headphone|wireless headphone|bluetooth headphone|bluetooth earphone)\b/, "8518302000"],
  [/\b(dynamic driver|dynamic type|balanced armature|planar magnetic|bone conduction)\b/, "8518302000"],
  [/\b(headset|airpods|wireless earbuds)\b/, "8518302000"],
  [/\b(microphone|condenser mic|dynamic mic|studio mic|vocal mic|podcast mic|recording mic|mic stand|microphone stand)\b/, "8518108030"],
  [/\b(bluetooth speaker|portable speaker|wireless speaker|wifi speaker|mono speaker|smart speaker)\b/, "8518210000"],
  [/\b(stereo speaker|bookshelf speaker|floor speaker|tower speaker|2\.0\s*speaker)\b/, "8518220000"],
  [/\b(\bspeaker\b|woofer|tweeter|subwoofer|pa speaker)\b/, "8518298000"],
  [/\b(vr headset|virtual reality headset|ar glasses|mixed reality|oculus|meta quest|htc vive|vr goggle)\b/, "9004900090"],
  [/\b(binocular|binoculars|spotting scope|monocular|telescope|refractor telescope|reflector telescope)\b/, "9005100080"],
  [/\b(camera lens|zoom lens|prime lens|telephoto lens|wide.?angle lens|macro lens|fisheye lens|interchangeable lens)\b/, "9002116000"],
  [/\d+[-–]\d+mm\s*(f\/?\d|zoom)/, "9002116000"],
  [/\d+mm\s*f\/\d/, "9002116000"],
  [/f\/\d+(\.\d+)?\s*(lens|prime|zoom)/, "9002116000"],
  [/\b(digital camera|mirrorless camera|dslr camera|action camera|compact camera|point.and.shoot)\b/, "8525810000"],
  [/\b(dashcam|dash cam|drive recorder|camcorder|video camera|webcam|ccd camera|cmos camera)\b/, "8525810000"],
  [/\b(coolpix|cybershot|cyber-shot|finepix|powershot|lumix|exilim|ixus|ixy|handycam|eos|a7|alpha)\b/, "8525810000"],
  [/\bcamera\b/, "8525810000"],
  [/\b(piano keyboard|midi keyboard|digital piano|electric piano|synthesizer|synth|electronic organ|organ keyboard)\b/, "9207100010"],
  [/\b(pc keyboard|computer keyboard|mechanical keyboard|wireless keyboard|gaming keyboard|usb keyboard)\b/, "8471602000"],
  [/\b(\bkeyboard\b|\bmouse\b|trackpad|trackball|drawing tablet|graphics tablet|stylus tablet)\b/, "8471602000"],
  [/\b(pc monitor|lcd monitor|led monitor|computer monitor|gaming monitor|4k monitor|ultra-wide monitor)\b/, "8528620000"],
  [/\b(projector|mini projector|portable projector|home projector|dlp projector)\b/, "8528620000"],
  [/\b(boombox|radio cassette|stereo system|hi.fi system|hifi|component stereo|micro system)\b/, "8527916040"],
  [/\b(car stereo|car radio|car audio|car receiver|double din|single din|din radio|in-dash)\b/, "8527212510"],
  [/\b(portable radio|fm radio|am radio|shortwave radio|pocket radio|transistor radio|am.fm radio)\b/, "8527991500"],
  [/\b(music cd|audio cd|vinyl record|vinyl lp|lp record|lp album|\blp\b|minidisc)\b/, "8523492000"],
  [/\b(laptop|notebook computer|notebook pc|macbook|chromebook|ultrabook)\b/, "8471300100"],
  [/\b(desktop pc|desktop computer|pc tower|mini pc|all.in.one pc|nuc)\b/, "8471300100"],
  [/\b(ddr[345]|so-dimm|dimm|sdram|pc\d-\d+)\b/, "8471801000"],
  [/\b(m\.2 ssd|nvme ssd|sata ssd|hard drive|hdd|gpu|graphics card|cpu processor|motherboard|pcie card)\b/, "8471801000"],
  [/\b(wristwatch|wrist watch|pocket watch|automatic watch|mechanical watch|\bwatch\b)\b/, "9102110000"],
  [/\b(power supply|voltage converter|step.up converter|step.down converter|inverter unit|ups unit)\b/, "8504409570"],
  [/\b(ham radio|amateur radio|transceiver|walkie.?talkie|two.?way radio|hf radio|vhf radio|uhf radio)\b/, "8526925000"],
  [/\b(cd player|portable cd player|disc player|md player|mp3 player|digital audio player|dap|hi.res player)\b/, "8519813010"],
  [/\b(turntable|record player|vinyl player|record deck|phono player)\b/, "8519302000"],
  [/\b(vcr|vhs player|video recorder|dvr recorder|blu.?ray recorder|bd recorder)\b/, "8521106000"],
  [/\bclarinet\b/, "9205904020"],
  [/\b(saxophone|alto sax|tenor sax|soprano sax|baritone sax|\bsax\b)\b/, "9205904040"],
  [/\b(flute|piccolo|concert flute)\b/, "9205904060"],
  [/\b(oboe|bassoon|english horn|woodwind instrument)\b/, "9205904080"],
  [/\b(trumpet|trombone|french horn|tuba|euphonium|cornet|flugelhorn|bugle)\b/, "9205100080"],
  [/\b(manga|comic book|graphic novel|light novel|artbook|photobook|trade paperback)\b/, "4901100020"],
  [/\b(\bbook\b|textbook|novel|magazine|reference book)\b/, "4901100020"],
  [/\b(golf club|golf set|driver head|iron set|wedge head|putter head|fairway wood|hybrid club)\b/, "9506310000"],
  [/\b(golf shaft|graphite shaft|steel shaft|driver shaft|iron shaft|golf grip|golf bag|golf ball|golf tee)\b/, "9506390060"],
  [/\b(fishing reel|spinning reel|baitcasting reel|fly reel|casting reel|\breel\b)\b/, "9507306000"],
  [/\b(multimeter|dmm|oscilloscope|voltmeter|ammeter|clamp meter|lcr meter)\b/, "9030310000"],
  [/\b(rangefinder|laser measure|distance meter|level meter|optical instrument)\b/, "9013809100"],
];

export function hs2316(name: string): string {
  const n = name.toLowerCase();
  return HS2316.find(([re]) => re.test(n))?.[1] ?? "8517620090";
}

/** Append " No battery", dropping trailing words until the name fits in 80 bytes. */
export function addNoBattery(name: string): string {
  if (/no battery/i.test(name)) return name;
  const suffix = " No battery";
  const bytes = (s: string) => Buffer.byteLength(s, "utf8");
  let base = name.trimEnd();
  while (base && bytes(base + suffix) > 80) base = base.replace(/\s*\S+$/, "");
  return base + suffix;
}

export interface CargoProduct {
  name: string;
  item_id: string;
  hs_code?: string;
  hs_description?: string;
  origin_country?: string;
}

export interface CargoResult<P> {
  products: P[];
  /** Problems that must be fixed before the order is created. */
  errors: string[];
}

/**
 * Apply the store's 貨物内容 rules to each product.
 * `reviewedNames` maps eBay item id -> the title Claude cleaned up (jdm-direct-motors only).
 */
export function applyCargoRules<P extends CargoProduct>(
  products: P[],
  store: Store,
  country: string,
  reviewedNames: Record<string, string> = {}
): CargoResult<P> {
  const errors: string[] = [];
  const out = products.map((p) => {
    let name = p.name;
    if (store === "jdm-direct-motors") {
      const reviewed = reviewedNames[p.item_id];
      if (reviewed) name = addNoBattery(reviewed);
      else if (!/no battery/i.test(name)) errors.push(`item ${p.item_id}: title needs review ("${p.name}")`);
    }
    const hs = p.hs_code || (store === "love-of-japan" ? hs2316(p.name) : hs2419(p.name, country));
    const desc = p.hs_description || HS_DESCRIPTIONS[hs];
    if (!desc) errors.push(`item ${p.item_id}: HS ${hs} is not in the known 内容物リスト descriptions`);
    return { ...p, name, hs_code: hs, hs_description: desc ?? "", origin_country: p.origin_country || "JP" };
  });
  return { products: out, errors };
}
