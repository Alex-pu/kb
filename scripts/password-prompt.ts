import { stdin, stdout } from "node:process";

export async function askHidden(question: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Run this command from an interactive terminal so the password can be entered without echo.");
  }

  stdout.write(`${question}: `);
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          finish(new Error("Command cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0008" || character === "\u007f") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

export async function askConfirmedPassword(label = "Password"): Promise<string> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const password = await askHidden(`${label} (12–128 characters)`);
    if (password.length < 12 || password.length > 128) {
      stdout.write("Password must be between 12 and 128 characters.\n");
      continue;
    }

    const confirmation = await askHidden("Retype password");
    if (password === confirmation) return password;
    stdout.write("Passwords do not match. Please try again.\n");
  }
  throw new Error("Password confirmation failed three times.");
}
