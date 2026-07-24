import { installRuntimeInjector } from "../customization/runtime-injector-v2";

// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./popup.scss");
// eslint-disable-next-line @typescript-eslint/no-require-imports
require("./tailwind.css");

installRuntimeInjector();
