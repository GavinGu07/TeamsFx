// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

import axios from "axios";
import * as fs from "fs-extra";
import * as path from "path";
import * as tmp from "tmp";
import {
  CancellationToken,
  ChatContext,
  ChatRequest,
  ChatResponseFileTree,
  ChatResponseStream,
  ChatResult,
  LanguageModelChatUserMessage,
  Uri,
} from "vscode";

import { sampleProvider } from "@microsoft/teamsfx-core";
import {
  getSampleFileInfo,
  runWithLimitedConcurrency,
  sendRequestWithRetry,
} from "@microsoft/teamsfx-core/build/component/generator/utils";

import { TelemetryTriggerFrom, TelemetryEvent } from "../../../telemetry/extTelemetryEvents";
import { ExtTelemetry } from "../../../telemetry/extTelemetry";
import { CHAT_CREATE_SAMPLE_COMMAND_ID, TeamsChatCommand } from "../../consts";
import {
  brieflyDescribeProjectSystemPrompt,
  describeProjectSystemPrompt,
  getProjectMatchSystemPrompt,
} from "../../prompts";
import {
  getCopilotResponseAsString,
  getSampleDownloadUrlInfo,
  verbatimCopilotInteraction,
} from "../../utils";
import * as teamsTemplateMetadata from "./templateMetadata.json";
import { ProjectMetadata } from "./types";

export default async function createCommandHandler(
  request: ChatRequest,
  context: ChatContext,
  response: ChatResponseStream,
  token: CancellationToken
): Promise<ChatResult> {
  ExtTelemetry.sendTelemetryEvent(TelemetryEvent.CopilotChatCreateStart);
  const startTime = Date.now();
  const chatMessages: LanguageModelChatUserMessage[] = [];

  const matchedResult = await matchProject(request, token);

  if (matchedResult.length === 0) {
    response.markdown(
      "Sorry, I can't help with that right now. Please try to describe your app scenario.\n"
    );
    return {};
  }
  if (matchedResult.length === 1) {
    const firstMatch = matchedResult[0];
    await verbatimCopilotInteraction(
      "copilot-gpt-3.5-turbo",
      [
        describeProjectSystemPrompt,
        new LanguageModelChatUserMessage(
          `The project you are looking for is '${JSON.stringify(firstMatch)}'.`
        ),
      ],
      response,
      token
    );
    if (firstMatch.type === "sample") {
      const folder = await showFileTree(firstMatch, response);
      response.button({
        command: CHAT_CREATE_SAMPLE_COMMAND_ID,
        arguments: [folder],
        title: "Scaffold this sample",
      });
    } else if (firstMatch.type === "template") {
      response.button({
        command: "fx-extension.create",
        arguments: [TelemetryTriggerFrom.CopilotChat, firstMatch.data],
        title: "Create this template",
      });
    }

    return { metadata: { command: TeamsChatCommand.Create } };
  } else {
    response.markdown(
      `I found ${matchedResult.slice(0, 3).length} projects that match your description.\n`
    );
    for (const project of matchedResult.slice(0, 3)) {
      response.markdown(`- ${project.name}: `);
      await verbatimCopilotInteraction(
        "copilot-gpt-3.5-turbo",
        [
          brieflyDescribeProjectSystemPrompt,
          new LanguageModelChatUserMessage(
            `The project you are looking for is '${JSON.stringify(project)}'.`
          ),
        ],
        response,
        token
      );
      if (project.type === "sample") {
        response.button({
          command: CHAT_CREATE_SAMPLE_COMMAND_ID,
          arguments: [project],
          title: "Scaffold this sample",
        });
      } else if (project.type === "template") {
        response.button({
          command: "fx-extension.create",
          arguments: [TelemetryTriggerFrom.CopilotChat, project.data],
          title: "Create this template",
        });
      }
    }
    return { metadata: { command: TeamsChatCommand.Create } };
  }
}

async function matchProject(
  request: ChatRequest,
  token: CancellationToken
): Promise<ProjectMetadata[]> {
  const allProjectMetadata = [...getTeamsTemplateMetadata(), ...(await getTeamsSampleMetadata())];
  const messages = [
    getProjectMatchSystemPrompt(allProjectMetadata),
    new LanguageModelChatUserMessage(request.prompt),
  ];
  const response = await getCopilotResponseAsString("copilot-gpt-4", messages, token);
  const matchedProjectId: string[] = [];
  if (response) {
    try {
      const responseJson = JSON.parse(response);
      if (responseJson && responseJson.app) {
        matchedProjectId.push(...(responseJson.app as string[]));
      }
    } catch (e) {}
  }
  const result: ProjectMetadata[] = [];
  for (const id of matchedProjectId) {
    const matchedProject = allProjectMetadata.find((config) => config.id === id);
    if (matchedProject) {
      result.push(matchedProject);
    }
  }
  return result;
}

function getTeamsTemplateMetadata(): ProjectMetadata[] {
  return teamsTemplateMetadata.map((config) => {
    return {
      id: config.id,
      type: "template",
      platform: "Teams",
      name: config.name,
      description: config.description,
      data: {
        capabilities: config.id,
        "project-type": config["project-type"],
      },
    };
  });
}

async function getTeamsSampleMetadata(): Promise<ProjectMetadata[]> {
  const sampleCollection = await sampleProvider.SampleCollection;
  const result: ProjectMetadata[] = [];
  for (const sample of sampleCollection.samples) {
    result.push({
      id: sample.id,
      type: "sample",
      platform: "Teams",
      name: sample.title,
      description: sample.fullDescription,
    });
  }
  return result;
}

async function showFileTree(
  projectMetadata: ProjectMetadata,
  response: ChatResponseStream
): Promise<string> {
  response.markdown("\nHere is the files of the sample project.");
  const downloadUrlInfo = await getSampleDownloadUrlInfo(projectMetadata.id);
  const { samplePaths, fileUrlPrefix } = await getSampleFileInfo(downloadUrlInfo, 2);
  const tempFolder = tmp.dirSync({ unsafeCleanup: true }).name;
  const nodes = await buildFileTree(
    fileUrlPrefix,
    samplePaths,
    tempFolder,
    downloadUrlInfo.dir,
    2,
    20
  );
  response.filetree(nodes, Uri.file(path.join(tempFolder, downloadUrlInfo.dir)));
  return path.join(tempFolder, downloadUrlInfo.dir);
}

async function buildFileTree(
  fileUrlPrefix: string,
  samplePaths: string[],
  dstPath: string,
  relativeFolderName: string,
  retryLimits: number,
  concurrencyLimits: number
): Promise<ChatResponseFileTree[]> {
  const root: ChatResponseFileTree = {
    name: relativeFolderName,
    children: [],
  };
  const downloadCallback = async (samplePath: string) => {
    const file = (await sendRequestWithRetry(async () => {
      return await axios.get(fileUrlPrefix + samplePath, {
        responseType: "arraybuffer",
      });
    }, retryLimits)) as unknown as any;
    const relativePath = path.relative(`${relativeFolderName}/`, samplePath);
    const filePath = path.join(dstPath, samplePath);
    fileTreeAdd(root, relativePath);
    await fs.ensureFile(filePath);
    await fs.writeFile(filePath, Buffer.from(file.data));
  };
  await runWithLimitedConcurrency(samplePaths, downloadCallback, concurrencyLimits);
  return root.children ?? [];
}

function fileTreeAdd(root: ChatResponseFileTree, relativePath: string) {
  const filename = path.basename(relativePath);
  const folderName = path.dirname(relativePath);
  const segments = path.sep === "\\" ? folderName.split("\\") : folderName.split("/");
  let parent = root;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (segment === ".") {
      continue;
    }
    let child = parent.children?.find((child) => child.name === segment);
    if (!child) {
      child = {
        name: segment,
        children: [],
      };
      parent.children?.push(child);
    }
    parent = child;
  }
  parent.children?.push({
    name: filename,
  });
}
