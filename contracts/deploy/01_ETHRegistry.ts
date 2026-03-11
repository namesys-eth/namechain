import { artifacts, execute } from "@rocketh";
import { zeroAddress } from "viem";
import {
  MAX_EXPIRY,
  DEPLOYMENT_ROLES,
} from "../script/deploy-constants.js";

// TODO: ownership
export default execute(
  async ({ deploy, execute: write, get, namedAccounts: { deployer } }) => {
    const rootRegistry =
      get<(typeof artifacts.PermissionedRegistry)["abi"]>("RootRegistry");

    const hcaFactory =
      get<(typeof artifacts.MockHCAFactoryBasic)["abi"]>("HCAFactory");

    const registryMetadata = get<
      (typeof artifacts.SimpleRegistryMetadata)["abi"]
    >("SimpleRegistryMetadata");

    const ethRegistry = await deploy("ETHRegistry", {
      account: deployer,
      artifact: artifacts.PermissionedRegistry,
      args: [
        hcaFactory.address,
        registryMetadata.address,
        deployer,
        DEPLOYMENT_ROLES.ETH_REGISTRY_ROOT,
      ],
    });

    await write(rootRegistry, {
      account: deployer,
      functionName: "register",
      args: [
        "eth",
        deployer,
        ethRegistry.address,
        zeroAddress,
        DEPLOYMENT_ROLES.ETH_TOKEN,
        MAX_EXPIRY,
      ],
    });

    await write(ethRegistry, {
      account: deployer,
      functionName: "setParent",
      args: [rootRegistry.address, "eth"],
    });
  },
  {
    tags: ["ETHRegistry", "l1"],
    dependencies: ["RootRegistry", "HCAFactory", "RegistryMetadata"],
  },
);
