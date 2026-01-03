import * as Schemas from "../core/Schemas";

export class IntentHandler {
  /**
   * Validates an intent against the game's schema.
   * @param intent The intent object to validate.
   * @returns An object indicating if the intent is valid and an optional error message.
   */
  static validate(intent: any): { valid: boolean; error?: string } {
    const result = Schemas.Intent.safeParse(intent);

    if (!result.success) {
      const issue = result.error.issues[0];
      if (!issue) {
        return { valid: false, error: "Unknown validation error" };
      }

      let message = issue.message;

      // Handle missing fields (invalid_type where message indicates received is undefined)
      if (
        issue.code === "invalid_type" &&
        issue.message.includes("received undefined")
      ) {
        const path = issue.path.join(".");
        message = `Missing ${path}`;
      } else if (issue.code === "invalid_union") {
        if (intent && intent.type) {
          message = `Invalid properties for intent type: ${intent.type}`;
        } else {
          message = "Missing or invalid intent type";
        }
      }

      return { valid: false, error: message };
    }

    return { valid: true };
  }

  /**
   * Wraps a payload in the correct structure expected by the game.
   * @param type The type of intent.
   * @param payload The intent payload.
   * @returns The wrapped intent message.
   */
  static createIntent(type: string, payload: any): any {
    return {
      type: "intent",
      intent: {
        type,
        ...payload,
      },
    };
  }
}
