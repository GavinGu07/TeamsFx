import * as dree from "dree";
import { existsSync } from "fs";
import * as vscode from "vscode";
import { AgentRequest } from "../chat/agent";
import {
  LanguageModelID,
  getResponseAsStringCopilotInteraction,
  verbatimCopilotInteraction,
} from "../chat/copilotInteractions";
import { IntentDetectionTarget, detectIntent } from "../chat/intentDetection";
import {
  SlashCommand,
  SlashCommandHandlerResult,
  SlashCommands,
} from "../chat/slashCommands";
import { AzureServices } from "../data/azureService";
import * as prompt from "../prompt/codeToCloudPrompt";
import { runWithLimitedConcurrency } from "../util";
import path = require("path");

const codeToCloudCommandName = "codetocloud";

export function getCodeToCloudCommand(): SlashCommand {
  return [
    codeToCloudCommandName,
    {
      shortDescription: `code to cloud`,
      longDescription: `code to cloud`,
      intentDescription: "",
      handler: (request: AgentRequest) => codeToCloudHandler(request),
    },
  ];
}

const recommendHandlerName = "recommend";
function getRecommendHandler(): SlashCommand {
  return [
    recommendHandlerName,
    {
      shortDescription: `Recommend Azure Resources for your app, this is the first step to migrate your app to cloud.`,
      longDescription: `Recommend Azure Resources for your app, this is the first step to migrate your app to cloud.`,
      intentDescription: "",
      handler: (request: AgentRequest) => recommendHandler(request),
    },
  ];
}

const improveRecommendHandlerName = "improveRecommend";
function getImproveRecommendHandler(): SlashCommand {
  return [
    improveRecommendHandlerName,
    {
      shortDescription: `Improve, Add, Modify or Remove Azure Resources for your app. Used for improving the previous recommended Azure Resources for your app.`,
      longDescription: `Improve, Add, Modify or Remove Azure Resources for your app.  Used for improving the previous recommended Azure Resources for your app.`,
      intentDescription: "",
      handler: (request: AgentRequest) => improveRecommendHandler(request),
    },
  ];
}

const pipelineHandlerName = "pipeline";
function getPipelineHandler(): SlashCommand {
  return [
    pipelineHandlerName,
    {
      shortDescription: `Create and Improve GitHub Action pipeline for your app. After you recommend azure resource for your app, you can create and improve GitHub Action pipeline for your app.`,
      longDescription: `Create and Improve GitHub Action pipeline for your app. After you recommend azure resource for your app, you can create and improve GitHub Action pipeline for your app.`,
      intentDescription: "",
      handler: (request: AgentRequest) => pipelineHandler(request),
    },
  ];
}

const LANGUAGE_MODEL_GPT4_ID = "copilot-gpt-4";
const LANGUAGE_MODEL_GPT35_TURBO_ID = "copilot-gpt-3.5-turbo";

const handlerMap = new Map([
  getRecommendHandler(),
  // getPipelineHandler(),
  getImproveRecommendHandler(),
]);
const invokeableCodeToCloudSubHandlers: SlashCommands = new Map();
for (const [name, config] of handlerMap.entries()) {
  invokeableCodeToCloudSubHandlers.set(name, config);
}

async function codeToCloudHandler(
  request: AgentRequest
): Promise<SlashCommandHandlerResult> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0].uri.fsPath;
  if (!workspaceFolder) {
    request.response.markdown(
      vscode.l10n.t("No workspace folder is opened.\n")
    );
  } else {
    const intentDetectionTargets = Array.from(
      invokeableCodeToCloudSubHandlers.entries()
    ).map(([name, config]) => ({
      name: name,
      intentDetectionDescription:
        config.intentDescription || config.shortDescription,
    }));

    const detectedTarget = await detectIntentWithHistory(
      intentDetectionTargets,
      request
    );
    if (detectedTarget !== undefined) {
      const subHandlerName = detectedTarget.name;
      const subHandler = invokeableCodeToCloudSubHandlers.get(subHandlerName);
      if (subHandler !== undefined) {
        await subHandler.handler(request);
      }
    } else {
      request.response.markdown(
        vscode.l10n.t("Sorry, I can't help with that right now.\n")
      );
    }
  }

  return {
    chatAgentResult: { slashCommand: codeToCloudCommandName },
    followUp: [],
  };
}

const excludePaths = [
  ".git",
  "node_modules",
  "dist",
  "infra",
  "Deployment",
  ".github",
  ".vscode",
  ".gitignore",
  ".npmignore",
  ".babelrc",
  "package-lock.json",
  "LICENSE",
  "LICENSE.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "teamsapp.local.yml",
  "teamsapp.yml",
  "azure.yaml",
];

const excludeExtensions = [
  /.*\.css$/,
  /.*\.resx$/,
  /.*\.zip$/,
  /.*\.pbix$/,
  /.*\.idx$/,
  /.*\.pack$/,
  /.*\.rev$/,
  /.*\.png$/,
  /.*\.jpg$/,
  /.*\.jpeg$/,
  /.*\.resx$/,
  /.*\.gif$/,
  /.*\.bicep$/,
  /.*\.tf$/,
  /.*\.txt$/,
  /.*\.html$/,
  /.*\.d\.ts$/,
  /.*\.dll$/,
];

const excludeReg = [
  new RegExp(excludePaths.join("|")),
  ...excludeExtensions.map((ext) => new RegExp(ext)),
];

class WorkspaceContext {
  workspaceFolder: string;
  workspaceFolderTree: dree.Dree;

  constructor(workspaceFolder: string) {
    this.workspaceFolder = workspaceFolder;
  }

  async constuctWorkspaceFolderTree(): Promise<dree.Dree> {
    const folderDree: dree.Dree = await dree.scanAsync(this.workspaceFolder, {
      exclude: excludeReg,
    });

    const filterEmptyDirectory = (node: dree.Dree): void => {
      if (node.type === dree.Type.DIRECTORY) {
        node.children?.forEach((child) => filterEmptyDirectory(child));
        node.children = node.children?.filter((child) => {
          if (
            child.type === dree.Type.DIRECTORY &&
            (!child.children || child.children.length === 0)
          ) {
            return false;
          }
          return true;
        });
      }
    };

    filterEmptyDirectory(folderDree);

    return folderDree;
  }

  public async getWorkspaceFolderTree(): Promise<dree.Dree> {
    if (!this.workspaceFolderTree) {
      this.workspaceFolderTree = await this.constuctWorkspaceFolderTree();
    }

    return this.workspaceFolderTree;
  }

  public async getWorkspaceFolderTreeString(): Promise<string> {
    let folderTree = await this.getWorkspaceFolderTree();
    let folderTreeString = await dree.parseTreeAsync(folderTree);
    folderTreeString = folderTreeString
      .replace(/├── /g, "")
      .replace(/├─> /g, "")
      .replace(/│  /g, "")
      .replace(/└── /g, "")
      .replace(/└─> /g, "");

    return folderTreeString;
  }

  public async asyncScanWorkspace(
    callback: (node: dree.Dree) => void,
    exclude: RegExp[] = excludeReg
  ) {
    await dree.scanAsync(this.workspaceFolder, { exclude }, callback);
  }
}

class ChatMessageHistory {
  recommendChatMessageHistory: vscode.LanguageModelMessage[] = [];

  public addRecommendChatMessageHistory(
    ...history: vscode.LanguageModelMessage[]
  ) {
    this.recommendChatMessageHistory.push(...history);
  }

  public getRecommendChatMessageHistory() {
    return this.recommendChatMessageHistory;
  }
}

/** Context of current workspace */
class Context {
  static instance: Context;
  workspaceFolder: string;
  workspaceContext: WorkspaceContext;
  chatMessageHistory: ChatMessageHistory;

  constructor(workspaceFolder: string) {
    // TODO: the workspace folder should exist
    this.workspaceFolder = workspaceFolder;
    this.workspaceContext = new WorkspaceContext(workspaceFolder);
    this.chatMessageHistory = new ChatMessageHistory();
  }

  public static getInstance(): Context {
    const workspaceFolder = vscode.workspace.workspaceFolders![0].uri.fsPath;
    if (
      !Context.instance ||
      Context.instance.workspaceFolder !== workspaceFolder
    ) {
      Context.instance = new Context(workspaceFolder);
    }

    return Context.instance;
  }
}

/** Recommend and Improve Azure Resources */
export interface ScanProjectResult {
  filePath: string;
  explanation?: string;
  relevance: number;
}

export interface VerifyFilePathResult {
  relativePath: string;
  absolutePath: string;
}

export interface AnalyzeFileResult {
  filePath: string;
  analyzeResult: string;
}

const TopFileNumber = 10;

async function recommendHandler(
  request: AgentRequest
): Promise<SlashCommandHandlerResult> {
  // first recommendation
  const scanProjectResults: ScanProjectResult[] = await scanProject(request);
  const filepaths: VerifyFilePathResult[] = await verifyFilePath(
    scanProjectResults.map((item) => item.filePath)
  );
  const analyzeFileResults: AnalyzeFileResult[] = await analyzeFile(
    filepaths.map((item) => item.absolutePath),
    request
  );
  // TODO: check token size
  const analyzeSummarization: string = await summarizeAnalyzeResult(
    analyzeFileResults.map((item) => item.analyzeResult),
    request
  );
  const proposals: string[] = await recommendProposal(
    analyzeSummarization,
    request
  );

  await aggregateProposal(proposals, request);

  return undefined;
}

async function scanProject(
  request: AgentRequest
): Promise<ScanProjectResult[]> {
  request.response.progress("Scan Project...");

  const context: Context = Context.getInstance();
  const workspaceContext: WorkspaceContext = context.workspaceContext;

  const folderTreeString =
    await workspaceContext.getWorkspaceFolderTreeString();
  const { systemPrompt, userPrompt } = prompt.getScanProjectPrompt(
    folderTreeString,
    TopFileNumber
  );
  const response = await getResponseInteraction(
    systemPrompt,
    userPrompt,
    request,
    LANGUAGE_MODEL_GPT4_ID
  );

  let scanProjectResult: ScanProjectResult[] = [];
  try {
    scanProjectResult = JSON.parse(response).result;
    scanProjectResult.sort((a, b) => b.relevance - a.relevance);
    scanProjectResult = scanProjectResult.slice(0, TopFileNumber);
  } catch (error) {
    // rule-based file path filtering
    const cache = new Set<string>();
    workspaceContext.asyncScanWorkspace((node) => {
      if (scanProjectResult.length > TopFileNumber) {
        return;
      }

      const fileRelativePathWithoutExt = path.join(
        path.dirname(node.relativePath),
        node.name.split(".")[0]
      );

      if (cache.has(fileRelativePathWithoutExt)) {
        return;
      } else {
        cache.add(fileRelativePathWithoutExt);
        scanProjectResult.push({
          filePath: node.relativePath,
          relevance: 10,
        });
      }
    });
  }

  request.response.markdown(
    `## Identify the following files for analysis: \n\n
\`\`\`
${scanProjectResult.map((item) => `- ${item.filePath}`).join("\n")}
\`\`\``
  );

  return scanProjectResult;
}

async function verifyFilePath(
  scanedFilePaths: string[]
): Promise<VerifyFilePathResult[]> {
  const filePaths: VerifyFilePathResult[] = [];
  const workspaceContext: WorkspaceContext =
    Context.getInstance().workspaceContext;

  const scanFilePaths = scanedFilePaths.map((item) => {
    return {
      relativePath: item,
      absolutePath: path.join(workspaceContext.workspaceFolder, item),
    };
  });

  scanFilePaths.forEach((item) => {
    if (existsSync(item.absolutePath)) {
      filePaths.push({
        relativePath: item.relativePath,
        absolutePath: item.absolutePath,
      });
    } else {
      console.log(
        `File not exists: ${item.relativePath} - ${item.absolutePath}`
      );
    }
    // TODO: else
  });

  return filePaths;
}

async function analyzeFile(
  filePaths: string[],
  request: AgentRequest
): Promise<AnalyzeFileResult[]> {
  const result: AnalyzeFileResult[] = [];

  const filePathContents = await Promise.all(
    filePaths.map(async (filePath) => {
      const fileContent = await vscode.workspace.fs.readFile(
        vscode.Uri.file(filePath)
      );
      return {
        filePath,
        fileContent: Buffer.from(fileContent).toString("utf-8"),
      };
    })
  );

  await runWithLimitedConcurrency(
    filePathContents,
    async (item) => {
      request.response.progress(`Analyze ${item.filePath}...`);
      const { systemPrompt, userPrompt } = prompt.getAnalyzeFilePrompt(
        item.filePath,
        item.fileContent
      );
      const response = await getResponseInteraction(
        systemPrompt,
        userPrompt,
        request
      );

      result.push({
        filePath: filePaths[result.length],
        analyzeResult: response,
      });
    },
    5
  );

  return result;
}

async function summarizeAnalyzeResult(
  analyzeResults: string[],
  request: AgentRequest
): Promise<string> {
  request.response.progress("Aggregrate Analyze Result...");

  const { systemPrompt, userPrompt } =
    prompt.getSummarizeAnalyzeResultPrompt(analyzeResults);

  return await getResponseInteraction(systemPrompt, userPrompt, request);
}

const ProposalNumber = 3;

async function recommendProposal(
  analyzeSummarization: string,
  request: AgentRequest
): Promise<string[]> {
  request.response.progress(`Recommend Azure Resource proposal...`);

  const proposals: string[] = [];
  const allAzureService = Object.values(AzureServices).join("\n\n");
  const { systemPrompt, userPrompt } = prompt.getRecommendProposalPrompt(
    analyzeSummarization,
    allAzureService,
    request.userPrompt
  );

  await runWithLimitedConcurrency(
    [...Array(ProposalNumber).keys()],
    async (index) => {
      const response = await getResponseInteraction(
        systemPrompt,
        userPrompt,
        request,
        LANGUAGE_MODEL_GPT4_ID
      );
      proposals.push(response);
    },
    5
  );

  return proposals;
}

async function aggregateProposal(
  proposals: string[],
  request: AgentRequest
): Promise<void> {
  request.response.progress(`Aggregate Azure Resource...`);

  const chatMessageHistory: vscode.LanguageModelMessage[] = [];
  const systemPrompt = prompt.RecommendSystemPrompt;
  const userCountPrompt = prompt.getRecommendCountPrompt(proposals).userPrompt;
  const countResponse = await getResponseInteraction(
    systemPrompt,
    userCountPrompt,
    request,
    LANGUAGE_MODEL_GPT4_ID,
    chatMessageHistory
  );
  chatMessageHistory.push(
    new vscode.LanguageModelUserMessage(userCountPrompt),
    new vscode.LanguageModelAssistantMessage(countResponse)
  );

  const userSelectPrompt = prompt.getRecommendSelectPrompt(
    ProposalNumber,
    countResponse
  ).userPrompt;
  const selectResponse = await getResponseInteraction(
    systemPrompt,
    userSelectPrompt,
    request,
    LANGUAGE_MODEL_GPT4_ID,
    chatMessageHistory
  );
  chatMessageHistory.push(
    new vscode.LanguageModelUserMessage(userSelectPrompt),
    new vscode.LanguageModelAssistantMessage(selectResponse)
  );

  const userAggregatePrompt = prompt.getRecommendAggregatePrompt(
    ProposalNumber,
    selectResponse
  ).userPrompt;
  await verbatimInteraction(
    systemPrompt,
    userAggregatePrompt,
    request,
    LANGUAGE_MODEL_GPT4_ID,
    chatMessageHistory
  );
}

async function improveRecommendHandler(
  request: AgentRequest
): Promise<SlashCommandHandlerResult> {
  request.response.progress("Improve Azure Resources...");

  const chatMessageHistory = collectChatMessageHistory(request, 4);

  const { systemPrompt, userPrompt } = prompt.getImproveRecommendPrompt(
    request.userPrompt
  );

  const response: {
    copilotResponded: boolean;
    copilotResponse: undefined | string;
  } = await verbatimInteraction(
    systemPrompt,
    userPrompt,
    request,
    LANGUAGE_MODEL_GPT4_ID,
    chatMessageHistory
  );

  if (response.copilotResponded) {
    Context.getInstance().chatMessageHistory.addRecommendChatMessageHistory(
      new vscode.LanguageModelAssistantMessage(
        response.copilotResponse as string
      )
    );
  }

  return undefined;
}

/** Recommend and Improve GitHub Action Pipeline */
async function pipelineHandler(
  request: AgentRequest
): Promise<SlashCommandHandlerResult> {
  return undefined;
}

function collectChatMessageHistory(
  request: AgentRequest,
  historyNumber: number = 6
): vscode.LanguageModelMessage[] {
  const chatMessageHistory: vscode.LanguageModelMessage[] = [];

  for (let history of request.context.history.slice(-historyNumber)) {
    if (history instanceof vscode.ChatRequestTurn) {
      const userPrompt = (history as vscode.ChatRequestTurn).prompt;
      chatMessageHistory.push(new vscode.LanguageModelUserMessage(userPrompt));
    } else {
      for (let response of history.response) {
        let assistantPrompt = "";
        switch (response.constructor) {
          case vscode.ChatResponseMarkdownPart:
            assistantPrompt = (response as vscode.ChatResponseMarkdownPart)
              .value.value;
            break;
        }
        if (assistantPrompt !== "") {
          chatMessageHistory.push(
            new vscode.LanguageModelAssistantMessage(assistantPrompt)
          );
        }
      }
    }
  }

  return chatMessageHistory;
}

async function getResponseInteraction(
  systemPrompt: string,
  userPrompt: string,
  request: AgentRequest,
  languageModelID: LanguageModelID = LANGUAGE_MODEL_GPT35_TURBO_ID,
  chatMessageHistory: vscode.LanguageModelMessage[] = []
): Promise<string> {
  const originalUserPrompt = request.userPrompt;
  request.userPrompt = userPrompt;
  request.commandVariables = { languageModelID, chatMessageHistory };
  const response = await getResponseAsStringCopilotInteraction(
    systemPrompt,
    request
  );
  request.userPrompt = originalUserPrompt;
  request.commandVariables = undefined;
  return response || "";
}

async function verbatimInteraction(
  systemPrompt: string,
  userPrompt: string,
  request: AgentRequest,
  languageModelID: LanguageModelID = LANGUAGE_MODEL_GPT35_TURBO_ID,
  chatMessageHistory: vscode.LanguageModelMessage[] = []
): Promise<{ copilotResponded: boolean; copilotResponse: undefined | string }> {
  const originalUserPrompt = request.userPrompt;
  request.userPrompt = userPrompt;
  request.commandVariables = { languageModelID, chatMessageHistory };
  const response = await verbatimCopilotInteraction(systemPrompt, request);
  request.userPrompt = originalUserPrompt;
  request.commandVariables = undefined;
  return response;
}

async function detectIntentWithHistory(
  intentDetectionTargets: {
    name: string;
    intentDetectionDescription: string;
  }[],
  request: AgentRequest
): Promise<IntentDetectionTarget | undefined> {
  const originalUserPrompt = request.userPrompt;
  let userPrompt = request.userPrompt;
  const recommendChatMessageHistory: vscode.LanguageModelMessage[] =
    Context.getInstance().chatMessageHistory.getRecommendChatMessageHistory();
  if (recommendChatMessageHistory.length > 0) {
    userPrompt = `You have recommend some azure resources for me. And now my expectation is ${userPrompt}`;
  }
  request.userPrompt = userPrompt;
  const chatMessageHistory: vscode.LanguageModelMessage[] =
    collectChatMessageHistory(request, 2);
  request.commandVariables = {
    languageModelID: "copilot-gpt-4",
    chatMessageHistory,
  };

  const detectedTarget = await detectIntent(intentDetectionTargets, request);
  request.commandVariables = undefined;
  request.userPrompt = originalUserPrompt;

  return detectedTarget;
}
