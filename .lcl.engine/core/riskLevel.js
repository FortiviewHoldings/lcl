"use strict";
/**
 * SESSION RISK, SCORED ON ONE LADDER.
 *
 * The operator's design, in their words: the permission shield below the chat
 * input should carry a colour that follows the risk profile — green, yellow,
 * orange, red — so session exposure is visible in one glance, and a dedicated
 * per-session section shows each risk item colour-coded.
 *
 * The insight that makes it honest: risk is never one fact. It is the pair of
 * WHERE content goes and WHAT is enabled. A secret in a sandboxed script on the
 * operator's own machine is green; the SAME secret about to leave to a vendor
 * is red. So this module scores the combination, and every UI surface reads the
 * result rather than inventing its own colour.
 *
 * PURE. No I/O, no requires. It takes a snapshot of the session's state and
 * returns a level and a per-item breakdown. Both main (to hand the renderer a
 * value) and the renderer (to paint) call it, so the ladder cannot drift.
 */

const LEVELS = ["green", "yellow", "orange", "red"];
const rank = (lvl) => Math.max(0, LEVELS.indexOf(lvl));
/** The worse (higher) of two levels. */
function worst(a, b) { return rank(a) >= rank(b) ? a : b; }
function worstOf(levels) { return levels.reduce((acc, l) => worst(acc, l), "green"); }

/**
 * Where the session's content actually goes, folded to a rung.
 *
 *   local engine (nothing leaves the machine) ............ green
 *   the operator's OWN node (their hardware) ............. green — it is theirs,
 *       and with no secrets in play there is nothing to be alarmed about; the
 *       panel still says it answers over the network, but the shield stays calm
 *   a third party (a cloud API or a rented box) .......... yellow — a vendor
 *       sees this conversation, worth knowing even without secrets
 *
 * The colour tracks REAL exposure. Green is the common, safe case (local or your
 * own node), so the operator actually sees it; the ladder rises only when a
 * third party is involved, secrets can leave, or a script runs unwatched.
 *
 * `destination` is the shape cloudModels.destinationOf returns, plus an
 * `isLocalEngine` flag for the on-disk model that never touches the network.
 */
function destinationLevel(destination) {
    if (!destination || destination.isLocalEngine) return "green";
    if (destination.owned) return "green";      // your own node — your hardware
    return "yellow";                            // a third party answers
}

/**
 * Assess a session. Every input is a plain fact the caller already holds; no
 * field is inferred and nothing is read from disk here.
 *
 *   destination        { owned, isLocalEngine, label, kind }  or null
 *   secrets            the "send secrets and keys" grant is on
 *   autoRun            approved-shape scripts run without a click
 *   requireIsolation   scripts refused unless a real sandbox exists
 *   writeMode          null | "notify" | "confirm"
 *   workspaceLinked    a folder is linked (so a script can write real files)
 *   networkForRemote   the remote is reached over the network / wirelessly
 */
function assess(input = {}) {
    const {
        destination = null,
        secrets = false,
        autoRun = false,
        requireIsolation = false,
        workspaceLinked = false,
        networkForRemote = true
    } = input;

    const leaves = !!destination && !destination.isLocalEngine;
    const owned = !!destination && !!destination.owned && leaves;
    const thirdParty = leaves && !destination.owned;

    const items = [];

    // WHERE this conversation is answered — always shown, it is the spine.
    const destLevel = destinationLevel(destination);
    items.push({
        key: "destination",
        level: destLevel,
        label: !leaves ? "Answered on this machine"
            : owned ? `Answered by ${destination.label || "your own node"}`
            : `Answered by ${destination.label || "a third party"}`,
        detail: !leaves ? "Nothing leaves this computer."
            : owned ? (networkForRemote
                ? "Your own hardware, reached over your network."
                : "Your own hardware.")
            : "A third party sees this conversation's content."
    });

    // SECRETS — real exposure is WHERE it leaves, so the level tracks the
    // destination, not the toggle. Armed while answered locally is inert (green,
    // shown so the operator knows it is on); leaving to their node is orange
    // (on the wire, even if to their own box); leaving to a third party is red.
    // Answered locally it never leaves, so it does not push the shield off green
    // by itself — the moment the destination becomes remote, Part C's warning
    // fires and this turns.
    if (secrets) {
        const level = thirdParty ? "red" : owned ? "orange" : "green";
        items.push({
            key: "secrets",
            level,
            label: "Secrets and keys are sent in full",
            detail: thirdParty
                ? `A detected secret can cross to ${destination.label || "a third party"}.`
                : owned
                    ? "A detected secret can travel over the wire to your own node."
                    : "Armed, but nothing leaves while this conversation is answered locally."
        });
    }

    // SCRIPTS — autoRun waives the click for a boxed run, which is a standing
    // yellow (something runs without your eyes on it). A workspace run always
    // stops for approval and shows the path, so a linked folder alone is green.
    if (autoRun) {
        items.push({
            key: "autoRun",
            level: "yellow",
            label: "Scripts run without asking",
            detail: "A script that passes inspection runs immediately, inside a sandbox."
        });
    }
    if (workspaceLinked) {
        items.push({
            key: "workspaceWrite",
            level: "green",
            label: requireIsolation ? "Scripts run only in a sandbox" : "Scripts approved one at a time",
            detail: requireIsolation
                ? "Scripts are refused unless a real sandbox exists."
                : "An approved script runs in your folder with your file permissions. Every run stops for approval and the card shows the exact path."
        });
    }

    const level = worstOf(items.map(i => i.level));
    return { level, items };
}

module.exports = { assess, destinationLevel, worst, worstOf, rank, LEVELS };
