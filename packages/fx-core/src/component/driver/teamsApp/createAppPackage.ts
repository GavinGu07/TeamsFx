// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import { hooks } from "@feathersjs/hooks/lib";
import { Colors, FxError, Result, err, ok, PluginManifestSchema } from "@microsoft/teamsfx-api";
import AdmZip from "adm-zip";
import fs from "fs-extra";
import * as path from "path";
import { Service } from "typedi";
import { getLocalizedString } from "../../../common/localizeUtils";
import { ErrorContextMW } from "../../../common/globalVars";
import { FileNotFoundError, InvalidActionInputError, JSONSyntaxError } from "../../../error/common";
import { DriverContext } from "../interface/commonArgs";
import { ExecutionResult, StepDriver } from "../interface/stepDriver";
import { addStartAndEndTelemetry } from "../middleware/addStartAndEndTelemetry";
import { WrapDriverContext } from "../util/wrapUtil";
import { Constants } from "./constants";
import { CreateAppPackageArgs } from "./interfaces/CreateAppPackageArgs";
import { manifestUtils } from "./utils/ManifestUtils";
import { InvalidFileOutsideOfTheDirectotryError } from "../../../error/teamsApp";
import { getResolvedManifest, normalizePath } from "./utils/utils";
import { copilotGptManifestUtils } from "./utils/CopilotGptManifestUtils";
import { ManifestType } from "../../utils/envFunctionUtils";

export const actionName = "teamsApp/zipAppPackage";

@Service(actionName)
export class CreateAppPackageDriver implements StepDriver {
  description = getLocalizedString("driver.teamsApp.description.createAppPackageDriver");
  readonly progressTitle = getLocalizedString(
    "plugins.appstudio.createPackage.progressBar.message"
  );

  public async execute(
    args: CreateAppPackageArgs,
    context: DriverContext
  ): Promise<ExecutionResult> {
    const wrapContext = new WrapDriverContext(context, actionName, actionName);
    const res = await this.build(args, wrapContext);
    return {
      result: res,
      summaries: wrapContext.summaries,
    };
  }

  @hooks([
    ErrorContextMW({ source: "Teams", component: "CreateAppPackageDriver" }),
    addStartAndEndTelemetry(actionName, actionName),
  ])
  public async build(
    args: CreateAppPackageArgs,
    context: WrapDriverContext
  ): Promise<Result<Map<string, string>, FxError>> {
    const result = this.validateArgs(args);
    if (result.isErr()) {
      return err(result.error);
    }

    let manifestPath = args.manifestPath;
    if (!path.isAbsolute(manifestPath)) {
      manifestPath = path.join(context.projectPath, manifestPath);
    }

    const manifestRes = await manifestUtils.getManifestV3(manifestPath, context);
    if (manifestRes.isErr()) {
      return err(manifestRes.error);
    }
    const manifest = manifestRes.value;
    // Deal with relative path
    // Environment variables should have been replaced by value
    // ./build/appPackage/appPackage.dev.zip instead of ./build/appPackage/appPackage.${{TEAMSFX_ENV}}.zip
    let zipFileName = args.outputZipPath;
    if (!path.isAbsolute(zipFileName)) {
      zipFileName = path.join(context.projectPath, zipFileName);
    }
    const zipFileDir = path.dirname(zipFileName);
    await fs.mkdir(zipFileDir, { recursive: true });

    let jsonFileName = args.outputJsonPath;
    if (!path.isAbsolute(jsonFileName)) {
      jsonFileName = path.join(context.projectPath, jsonFileName);
    }
    const jsonFileDir = path.dirname(jsonFileName);
    await fs.mkdir(jsonFileDir, { recursive: true });

    const appDirectory = path.dirname(manifestPath);

    const colorFile = path.resolve(appDirectory, manifest.icons.color);
    if (!(await fs.pathExists(colorFile))) {
      const error = new FileNotFoundError(
        actionName,
        colorFile,
        "https://aka.ms/teamsfx-actions/teamsapp-zipAppPackage"
      );
      return err(error);
    }
    const colorFileRelativePath = path.relative(appDirectory, colorFile);
    if (colorFileRelativePath.startsWith("..")) {
      return err(new InvalidFileOutsideOfTheDirectotryError(colorFile));
    }

    const outlineFile = path.resolve(appDirectory, manifest.icons.outline);
    if (!(await fs.pathExists(outlineFile))) {
      const error = new FileNotFoundError(
        actionName,
        outlineFile,
        "https://aka.ms/teamsfx-actions/teamsapp-zipAppPackage"
      );
      return err(error);
    }
    const outlineFileRelativePath = path.relative(appDirectory, outlineFile);
    if (outlineFileRelativePath.startsWith("..")) {
      return err(new InvalidFileOutsideOfTheDirectotryError(outlineFile));
    }

    // pre-check existence
    if (
      manifest.localizationInfo &&
      manifest.localizationInfo.additionalLanguages &&
      manifest.localizationInfo.additionalLanguages.length > 0
    ) {
      for (const language of manifest.localizationInfo.additionalLanguages) {
        const file = language.file;
        const fileName = `${appDirectory}/${file}`;
        if (!(await fs.pathExists(fileName))) {
          return err(
            new FileNotFoundError(
              actionName,
              fileName,
              "https://aka.ms/teamsfx-actions/teamsapp-zipAppPackage"
            )
          );
        }
      }
    }

    const zip = new AdmZip();
    zip.addFile(Constants.MANIFEST_FILE, Buffer.from(JSON.stringify(manifest, null, 4)));

    // outline.png & color.png, relative path
    let dir = path.dirname(manifest.icons.color);
    zip.addLocalFile(colorFile, dir === "." ? "" : dir);
    dir = path.dirname(manifest.icons.outline);
    zip.addLocalFile(outlineFile, dir === "." ? "" : dir);

    // localization file
    if (
      manifest.localizationInfo &&
      manifest.localizationInfo.additionalLanguages &&
      manifest.localizationInfo.additionalLanguages.length > 0
    ) {
      for (const language of manifest.localizationInfo.additionalLanguages) {
        const file = language.file;
        const fileName = path.resolve(appDirectory, file);
        const relativePath = path.relative(appDirectory, fileName);
        if (relativePath.startsWith("..")) {
          return err(new InvalidFileOutsideOfTheDirectotryError(fileName));
        }
        const dir = path.dirname(file);
        zip.addLocalFile(fileName, dir === "." ? "" : dir);
      }
    }

    // API ME, API specification and Adaptive card templates
    if (
      manifest.composeExtensions &&
      manifest.composeExtensions.length > 0 &&
      manifest.composeExtensions[0].composeExtensionType == "apiBased" &&
      manifest.composeExtensions[0].apiSpecificationFile
    ) {
      const apiSpecificationFile = path.resolve(
        appDirectory,
        manifest.composeExtensions[0].apiSpecificationFile
      );
      const checkExistenceRes = await this.validateReferencedFile(
        apiSpecificationFile,
        appDirectory
      );
      if (checkExistenceRes.isErr()) {
        return err(checkExistenceRes.error);
      }

      const addFileWithVariableRes = await this.addFileWithVariable(
        zip,
        manifest.composeExtensions[0].apiSpecificationFile,
        apiSpecificationFile,
        ManifestType.ApiSpec,
        context
      );
      if (addFileWithVariableRes.isErr()) {
        return err(addFileWithVariableRes.error);
      }

      if (manifest.composeExtensions[0].commands.length > 0) {
        for (const command of manifest.composeExtensions[0].commands) {
          if (command.apiResponseRenderingTemplateFile) {
            const adaptiveCardFile = path.resolve(
              appDirectory,
              command.apiResponseRenderingTemplateFile
            );
            const checkExistenceRes = await this.validateReferencedFile(
              adaptiveCardFile,
              appDirectory
            );
            if (checkExistenceRes.isErr()) {
              return err(checkExistenceRes.error);
            }
            const dir = path.dirname(command.apiResponseRenderingTemplateFile);
            this.addFileInZip(zip, dir, adaptiveCardFile);
          }
        }
      }
    }

    const plugins = manifest.copilotExtensions?.plugins;
    // API plugin
    if (plugins?.length && plugins[0].file) {
      const addFilesRes = await this.addPlugin(zip, plugins[0].file, appDirectory, context);
      if (addFilesRes.isErr()) {
        return err(addFilesRes.error);
      }
    }

    const declarativeCopilots = manifest.copilotExtensions?.declarativeCopilots;

    // Copilot GPT
    if (declarativeCopilots?.length && declarativeCopilots[0].file) {
      const copilotGptManifestFile = path.resolve(appDirectory, declarativeCopilots[0].file);
      const checkExistenceRes = await this.validateReferencedFile(
        copilotGptManifestFile,
        appDirectory
      );
      if (checkExistenceRes.isErr()) {
        return err(checkExistenceRes.error);
      }

      const addFileWithVariableRes = await this.addFileWithVariable(
        zip,
        declarativeCopilots[0].file,
        copilotGptManifestFile,
        ManifestType.DeclarativeCopilotManifest,
        context
      );
      if (addFileWithVariableRes.isErr()) {
        return err(addFileWithVariableRes.error);
      }

      const getCopilotGptRes = await copilotGptManifestUtils.getManifest(
        copilotGptManifestFile,
        context
      );

      if (getCopilotGptRes.isOk()) {
        if (getCopilotGptRes.value.actions) {
          const pluginFiles = getCopilotGptRes.value.actions.map((action) => action.file);

          for (const pluginFile of pluginFiles) {
            const pluginFileAbsolutePath = path.resolve(
              path.dirname(copilotGptManifestFile),
              pluginFile
            );

            const pluginFileRelativePath = path.relative(appDirectory, pluginFileAbsolutePath);
            const useForwardSlash = declarativeCopilots[0].file.concat(pluginFile).includes("/");

            const addPluginRes = await this.addPlugin(
              zip,
              normalizePath(pluginFileRelativePath, useForwardSlash),
              appDirectory,
              context
            );

            if (addPluginRes.isErr()) {
              return err(addPluginRes.error);
            }
          }
        }
      } else {
        return err(getCopilotGptRes.error);
      }
    }

    zip.writeZip(zipFileName);

    if (await fs.pathExists(jsonFileName)) {
      await fs.chmod(jsonFileName, 0o777);
    }
    await fs.writeFile(jsonFileName, JSON.stringify(manifest, null, 4));
    await fs.chmod(jsonFileName, 0o444);

    const builtSuccess = [
      { content: "(√)Done: ", color: Colors.BRIGHT_GREEN },
      { content: "Teams Package ", color: Colors.BRIGHT_WHITE },
      { content: zipFileName, color: Colors.BRIGHT_MAGENTA },
      { content: " built successfully!", color: Colors.BRIGHT_WHITE },
    ];
    context.logProvider.info(builtSuccess);
    return ok(new Map());
  }

  private static async expandEnvVars(
    filePath: string,
    ctx: WrapDriverContext,
    manifestType: ManifestType
  ): Promise<Result<string, FxError>> {
    const content = await fs.readFile(filePath, "utf8");
    return getResolvedManifest(content, filePath, manifestType, ctx);
  }

  private validateArgs(args: CreateAppPackageArgs): Result<any, FxError> {
    const invalidParams: string[] = [];
    if (!args || !args.manifestPath) {
      invalidParams.push("manifestPath");
    }
    if (!args || !args.outputJsonPath) {
      invalidParams.push("outputJsonPath");
    }
    if (!args || !args.outputZipPath) {
      invalidParams.push("outputZipPath");
    }
    if (invalidParams.length > 0) {
      return err(
        new InvalidActionInputError(
          actionName,
          invalidParams,
          "https://aka.ms/teamsfx-actions/teamsapp-zipAppPackage"
        )
      );
    } else {
      return ok(undefined);
    }
  }

  private async validateReferencedFile(
    file: string,
    directory: string
  ): Promise<Result<undefined, FxError>> {
    if (!(await fs.pathExists(file))) {
      return err(
        new FileNotFoundError(
          actionName,
          file,
          "https://aka.ms/teamsfx-actions/teamsapp-zipAppPackage"
        )
      );
    }

    const relativePath = path.relative(directory, file);
    if (relativePath.startsWith("..")) {
      return err(new InvalidFileOutsideOfTheDirectotryError(file));
    }

    return ok(undefined);
  }

  /**
   * Add plugin file and plugin related files to zip.
   * @param zip zip
   * @param pluginRelativePath plugin file path relative to app package folder
   * @param appDirectory app package path
   * @param context context
   * @returns result of adding plugin file and plugin related files
   */
  private async addPlugin(
    zip: AdmZip,
    pluginRelativePath: string,
    appDirectory: string,
    context: WrapDriverContext
  ): Promise<Result<undefined, FxError>> {
    const pluginFile = path.resolve(appDirectory, pluginRelativePath);
    const checkExistenceRes = await this.validateReferencedFile(pluginFile, appDirectory);
    if (checkExistenceRes.isErr()) {
      return err(checkExistenceRes.error);
    }

    const addFileWithVariableRes = await this.addFileWithVariable(
      zip,
      pluginRelativePath,
      pluginFile,
      ManifestType.PluginManifest,
      context
    );
    if (addFileWithVariableRes.isErr()) {
      return err(addFileWithVariableRes.error);
    }

    const addFilesRes = await this.addPluginRelatedFiles(
      zip,
      pluginRelativePath,
      appDirectory,
      context
    );
    if (addFilesRes.isErr()) {
      return err(addFilesRes.error);
    } else {
      return ok(undefined);
    }
  }

  /**
   * Add plugin related files (OpenAPI spec) to zip.
   * @param zip zip.
   * @param pluginFile plugin file path relative to app package folder.
   * @param appDirectory app package folder.
   * @param context context.
   * @returns results whether add files related to plugin is successful.
   */
  private async addPluginRelatedFiles(
    zip: AdmZip,
    pluginFile: string,
    appDirectory: string,
    context: WrapDriverContext
  ): Promise<Result<undefined, FxError>> {
    const pluginFilePath = path.join(appDirectory, pluginFile);
    let pluginContent;
    try {
      pluginContent = (await fs.readJSON(pluginFilePath)) as PluginManifestSchema;
    } catch (e) {
      return err(new JSONSyntaxError(pluginFilePath, e, actionName));
    }
    const runtimes = pluginContent.runtimes;
    if (runtimes && runtimes.length > 0) {
      for (const runtime of runtimes) {
        if (runtime.type === "OpenApi" && runtime.spec?.url) {
          const specFile = path.resolve(path.dirname(pluginFilePath), runtime.spec.url);
          // add openapi spec
          const checkExistenceRes = await this.validateReferencedFile(specFile, appDirectory);
          if (checkExistenceRes.isErr()) {
            return err(checkExistenceRes.error);
          }

          const entryName = path.relative(appDirectory, specFile);
          const useForwardSlash = pluginFile.concat(runtime.spec.url).includes("/");

          const addFileWithVariableRes = await this.addFileWithVariable(
            zip,
            normalizePath(entryName, useForwardSlash),
            specFile,
            ManifestType.ApiSpec,
            context
          );
          if (addFileWithVariableRes.isErr()) {
            return err(addFileWithVariableRes.error);
          }
        }
      }
    }

    return ok(undefined);
  }

  private async addFileWithVariable(
    zip: AdmZip,
    entryName: string,
    filePath: string,
    manifestType: ManifestType,
    context: WrapDriverContext
  ): Promise<Result<undefined, FxError>> {
    const expandedEnvVarResult = await CreateAppPackageDriver.expandEnvVars(
      filePath,
      context,
      manifestType
    );
    if (expandedEnvVarResult.isErr()) {
      return err(expandedEnvVarResult.error);
    }
    const content = expandedEnvVarResult.value;

    const attr = await fs.stat(filePath);
    zip.addFile(entryName, Buffer.from(content), "", attr.mode);

    return ok(undefined);
  }

  private addFileInZip(zip: AdmZip, zipPath: string, filePath: string) {
    zip.addLocalFile(filePath, zipPath === "." ? "" : zipPath);
  }
}
