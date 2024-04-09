/*These metrics are ported, with some enhancements, from the [RAGAS](https://github.com/explodinggradients/ragas) project. */
import mustache from "mustache";

import { Scorer, ScorerArgs } from "@braintrust/core";
import { LLMArgs } from "./llm";
import { buildOpenAIClient } from "./oai";
import OpenAI from "openai";
import { ListContains } from "./list";
import { EmbeddingSimilarity } from "./string";
import { z } from "zod";
import zodToJsonSchema from "zod-to-json-schema";

const DEFAULT_RAGAS_MODEL = "gpt-3.5-turbo-16k";

const ENTITY_PROMPT = `Given a text, extract unique entities without repetition. Ensure you consider different forms or mentions of the same entity as a single entity.

The output should be a well-formatted JSON instance that conforms to the JSON schema below.

As an example, for the schema {"properties": {"foo": {"title": "Foo", "description": "a list of strings", "type": "array", "items": {"type": "string"}}}, "required": ["foo"]}
the object {"foo": ["bar", "baz"]} is a well-formatted instance of the schema. The object {"properties": {"foo": ["bar", "baz"]}} is not well-formatted.

Here is the output JSON schema:
\`\`\`
{"type": "object", "properties": {"entities": {"title": "Entities", "type": "array", "items": {"type": "string"}}}, "required": ["entities"]}
\`\`\`

Do not return any preamble or explanations, return only a pure JSON string surrounded by triple backticks (\`\`\`).

Examples:

text: "The Eiffel Tower, located in Paris, France, is one of the most iconic landmarks globally.\n            Millions of visitors are attracted to it each year for its breathtaking views of the city.\n            Completed in 1889, it was constructed in time for the 1889 World's Fair."
output: \`\`\`{"entities": ["Eiffel Tower", "Paris", "France", "1889", "World's Fair"]}\`\`\`

text: "The Colosseum in Rome, also known as the Flavian Amphitheatre, stands as a monument to Roman architectural and engineering achievement.\n            Construction began under Emperor Vespasian in AD 70 and was completed by his son Titus in AD 80.\n            It could hold between 50,000 and 80,000 spectators who watched gladiatorial contests and public spectacles."
output: \`\`\`{"entities": ["Colosseum", "Rome", "Flavian Amphitheatre", "Vespasian", "AD 70", "Titus", "AD 80"]}\`\`\`

text: "The Great Wall of China, stretching over 21,196 kilometers from east to west, is a marvel of ancient defensive architecture.\n            Built to protect against invasions from the north, its construction started as early as the 7th century BC.\n            Today, it is a UNESCO World Heritage Site and a major tourist attraction."
output: \`\`\`{"entities": ["Great Wall of China", "21,196 kilometers", "7th century BC", "UNESCO World Heritage Site"]}\`\`\`

Your actual task:

text: {{text}}
output: `;

const entitySchema = z.object({
  entities: z.array(z.string()),
});

type RagasArgs = {
  input?: string;
  context: string | string[];
  model?: string;
} & LLMArgs;

/**
 * Estimates context recall by estimating TP and FN using annotated answer and
 * retrieved context.
 */
export const ContextEntityRecall: Scorer<
  string,
  RagasArgs & {
    pairwiseScorer?: Scorer<string, {}>;
  }
> = async (args) => {
  const { chatArgs, client, ...inputs } = parseArgs(args);

  const { expected, context } = checkRequired(
    { expected: inputs.expected, context: inputs.context },
    "ContextEntityRecall"
  );

  const makeArgs = (
    text: string
  ): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming => ({
    ...chatArgs,
    messages: [
      {
        role: "user",
        content: mustache.render(ENTITY_PROMPT, { text }),
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "extract_entities",
          description: "Extract unique entities from a given text",
          parameters: zodToJsonSchema(entitySchema),
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "extract_entities" } },
  });

  const responses = await Promise.all([
    client.chat.completions.create(makeArgs(expected)),
    client.chat.completions.create(makeArgs(context)),
  ]);

  const [expectedEntities, contextEntities] = responses.map(mustParseArgs);

  const score = await ListContains({
    pairwiseScorer: args.pairwiseScorer ?? EmbeddingSimilarity,
    allowExtraEntities: true,
    output: entitySchema.parse(contextEntities).entities,
    expected: entitySchema.parse(expectedEntities).entities,
  });

  return {
    name: "ContextEntityRecall",
    score: score.score,
    metadata: {
      contextEntities: contextEntities.entities,
      expectedEntities: expectedEntities.entities,
    },
  };
};

Object.defineProperty(ContextEntityRecall, "name", {
  value: "ContextEntityRecall",
  configurable: true,
});

const SENTENCE_PROMPT = `Please extract relevant sentences from the provided context that is absolutely required answer the following question. If no relevant sentences are found, or if you believe the question cannot be answered from the given context, return an empty array.  While extracting candidate sentences you're not allowed to make any changes to sentences from given context.

Your actual task:

question: {{question}}
context: {{context}}
candidate sentences: `;

const relevantSentencesSchema = z.object({
  sentences: z
    .array(
      z.object({
        sentence: z.string().describe("The selected sentence"),
        reasons: z
          .array(z.string())
          .describe(
            "Reasons why the sentence is relevant. Explain your thinking step by step."
          ),
      })
    )
    .describe("List of referenced sentences"),
});

export const ContextRelevancy: Scorer<string, RagasArgs> = async (args) => {
  const { chatArgs, client, ...inputs } = parseArgs(args);

  const { input, context } = checkRequired(
    { input: inputs.input, context: inputs.context },
    "ContextRelevancy"
  );

  const response = await client.chat.completions.create({
    ...chatArgs,
    messages: [
      {
        role: "user",
        content: mustache.render(SENTENCE_PROMPT, { question: input, context }),
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "extract_sentences",
          description: "Extract relevant sentences from a given context",
          parameters: zodToJsonSchema(relevantSentencesSchema),
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "extract_sentences" } },
  });

  const sentences = relevantSentencesSchema.parse(mustParseArgs(response));
  return {
    name: "ContextRelevancy",
    score:
      sentences.sentences.map((s) => s.sentence).join("").length /
      context.length,
    metadata: {
      relevantSentences: sentences.sentences,
    },
  };
};

const CONTEXT_RECALL_PROMPT = `Given a context, and an answer, analyze each sentence in the answer and classify if the sentence can be attributed to the given context or not. Use only "Yes" (1) or "No" (0) as a binary classification. Output json with reason.

The output should be a well-formatted JSON instance that conforms to the JSON schema below.

As an example, for the schema {"properties": {"foo": {"title": "Foo", "description": "a list of strings", "type": "array", "items": {"type": "string"}}}, "required": ["foo"]}
the object {"foo": ["bar", "baz"]} is a well-formatted instance of the schema. The object {"properties": {"foo": ["bar", "baz"]}} is not well-formatted.

Here is the output JSON schema:
\`\`\`
{"type": "array", "items": {"$ref": "#/definitions/ContextRecallClassificationAnswer"}, "definitions": {"ContextRecallClassificationAnswer": {"title": "ContextRecallClassificationAnswer", "type": "object", "properties": {"statement": {"title": "Statement", "type": "string"}, "attributed": {"title": "Attributed", "type": "integer"}, "reason": {"title": "Reason", "type": "string"}}, "required": ["statement", "attributed", "reason"]}}}
\`\`\`

Do not return any preamble or explanations, return only a pure JSON string surrounded by triple backticks (\`\`\`).

Examples:

question: "What can you tell me about albert Albert Einstein?"
context: "Albert Einstein (14 March 1879 - 18 April 1955) was a German-born theoretical physicist, widely held to be one of the greatest and most influential scientists of all time. Best known for developing the theory of relativity, he also made important contributions to quantum mechanics, and was thus a central figure in the revolutionary reshaping of the scientific understanding of nature that modern physics accomplished in the first decades of the twentieth century. His mass-energy equivalence formula E = mc2, which arises from relativity theory, has been called 'the world's most famous equation'. He received the 1921 Nobel Prize in Physics 'for his services to theoretical physics, and especially for his discovery of the law of the photoelectric effect', a pivotal step in the development of quantum theory. His work is also known for its influence on the philosophy of science. In a 1999 poll of 130 leading physicists worldwide by the British journal Physics World, Einstein was ranked the greatest physicist of all time. His intellectual achievements and originality have made Einstein synonymous with genius."
answer: "Albert Einstein born in 14 March 1879 was  German-born theoretical physicist, widely held to be one of the greatest and most influential scientists of all time. He received the 1921 Nobel Prize in Physics for his services to theoretical physics. He published 4 papers in 1905.  Einstein moved to Switzerland in 1895"
classification: \`\`\`[{"statement": "Albert Einstein, born on 14 March 1879, was a German-born theoretical physicist, widely held to be one of the greatest and most influential scientists of all time.", "attributed": 1, "reason": "The date of birth of Einstein is mentioned clearly in the context."}, {"statement": "He received the 1921 Nobel Prize in Physics for his services to theoretical physics.", "attributed": 1, "reason": "The exact sentence is present in the given context."}, {"statement": "He published 4 papers in 1905.", "attributed": 0, "reason": "There is no mention about papers he wrote in the given context."}, {"statement": "Einstein moved to Switzerland in 1895.", "attributed": 0, "reason": "There is no supporting evidence for this in the given context."}]\`\`\`

question: "who won 2020 icc world cup?"
context: "The 2022 ICC Men's T20 World Cup, held from October 16 to November 13, 2022, in Australia, was the eighth edition of the tournament. Originally scheduled for 2020, it was postponed due to the COVID-19 pandemic. England emerged victorious, defeating Pakistan by five wickets in the final to clinch their second ICC Men's T20 World Cup title."
answer: "England"
classification: \`\`\`[{"statement": "England won the 2022 ICC Men's T20 World Cup.", "attributed": 1, "reason": "From context it is clear that England defeated Pakistan to win the World Cup."}]\`\`\`

question: "What is the primary fuel for the Sun?"
context: "NULL"
answer: "Hydrogen"
classification: \`\`\`[{"statement": "The Sun's primary fuel is hydrogen.", "attributed": 0, "reason": "The context contains no information"}]\`\`\`

Your actual task:

question: {{question}}
context: {{context}}
answer: {{answer}}
classification:
`;
const contextRecallSchema = z.object({
  statements: z.array(
    z.object({
      statement: z.string(),
      attributed: z.number(),
      reason: z.string(),
    })
  ),
});

export const ContextRecall: Scorer<string, RagasArgs> = async (args) => {
  const { chatArgs, client, ...inputs } = parseArgs(args);
  const { input, expected, context } = checkRequired(
    { input: inputs.input, expected: inputs.expected, context: inputs.context },
    "ContextRecall"
  );

  const response = await client.chat.completions.create({
    ...chatArgs,
    messages: [
      {
        role: "user",
        content: mustache.render(CONTEXT_RECALL_PROMPT, {
          question: input,
          answer: expected,
          context,
        }),
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "extract_statements",
          parameters: zodToJsonSchema(contextRecallSchema),
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "extract_statements" } },
  });

  const statements = contextRecallSchema.parse(mustParseArgs(response));

  return {
    name: "ContextRecall",
    score:
      statements.statements.reduce(
        (acc, { attributed }) => acc + attributed,
        0
      ) / statements.statements.length,
    metadata: {
      statements: statements.statements,
    },
  };
};

const CONTEXT_PRECISION_PROMPT = `Given question, answer and context verify if the context was useful in arriving at the given answer. Give verdict as "1" if useful and "0" if not with json output.

The output should be a well-formatted JSON instance that conforms to the JSON schema below.

As an example, for the schema {"properties": {"foo": {"title": "Foo", "description": "a list of strings", "type": "array", "items": {"type": "string"}}}, "required": ["foo"]}
the object {"foo": ["bar", "baz"]} is a well-formatted instance of the schema. The object {"properties": {"foo": ["bar", "baz"]}} is not well-formatted.

Here is the output JSON schema:
\`\`\`
{"description": "Answer for the verification task whether the context was useful.", "type": "object", "properties": {"reason": {"title": "Reason", "description": "Reason for verification", "type": "string"}, "verdict": {"title": "Verdict", "description": "Binary (0/1) verdict of verification", "type": "integer"}}, "required": ["reason", "verdict"]}
\`\`\`

Do not return any preamble or explanations, return only a pure JSON string surrounded by triple backticks (\`\`\`).

Examples:

question: "What can you tell me about albert Albert Einstein?"
context: "Albert Einstein (14 March 1879 – 18 April 1955) was a German-born theoretical physicist, widely held to be one of the greatest and most influential scientists of all time. Best known for developing the theory of relativity, he also made important contributions to quantum mechanics, and was thus a central figure in the revolutionary reshaping of the scientific understanding of nature that modern physics accomplished in the first decades of the twentieth century. His mass–energy equivalence formula E = mc2, which arises from relativity theory, has been called \"the world's most famous equation\". He received the 1921 Nobel Prize in Physics \"for his services to theoretical physics, and especially for his discovery of the law of the photoelectric effect\", a pivotal step in the development of quantum theory. His work is also known for its influence on the philosophy of science. In a 1999 poll of 130 leading physicists worldwide by the British journal Physics World, Einstein was ranked the greatest physicist of all time. His intellectual achievements and originality have made Einstein synonymous with genius."
answer: "Albert Einstein born in 14 March 1879 was German-born theoretical physicist, widely held to be one of the greatest and most influential scientists of all time. He received the 1921 Nobel Prize in Physics for his services to theoretical physics. He published 4 papers in 1905. Einstein moved to Switzerland in 1895"
verification: \`\`\`{"reason": "The provided context was indeed useful in arriving at the given answer. The context includes key information about Albert Einstein's life and contributions, which are reflected in the answer.", "verdict": 1}\`\`\`

question: "who won 2020 icc world cup?"
context: "The 2022 ICC Men's T20 World Cup, held from October 16 to November 13, 2022, in Australia, was the eighth edition of the tournament. Originally scheduled for 2020, it was postponed due to the COVID-19 pandemic. England emerged victorious, defeating Pakistan by five wickets in the final to clinch their second ICC Men's T20 World Cup title."
answer: "England"
verification: \`\`\`{"reason": "the context was useful in clarifying the situation regarding the 2020 ICC World Cup and indicating that England was the winner of the tournament that was intended to be held in 2020 but actually took place in 2022.", "verdict": 1}\`\`\`

question: "What is the tallest mountain in the world?"
context: "The Andes is the longest continental mountain range in the world, located in South America. It stretches across seven countries and features many of the highest peaks in the Western Hemisphere. The range is known for its diverse ecosystems, including the high-altitude Andean Plateau and the Amazon rainforest."
answer: "Mount Everest."
verification: \`\`\`{"reason": "the provided context discusses the Andes mountain range, which, while impressive, does not include Mount Everest or directly relate to the question about the world's tallest mountain.", "verdict": 0}\`\`\`

Your actual task:

question: {{question}}
context: {{context}}
answer: {{answer}}
verification:
`;

const contextPrecisionSchema = z.object({
  reason: z.string().describe("Reason for verification"),
  verdict: z.number().describe("Binary (0/1) verdict of verification"),
});

export const ContextPrecision: Scorer<string, RagasArgs> = async (args) => {
  const { chatArgs, client, ...inputs } = parseArgs(args);
  const { input, expected, context } = checkRequired(
    { input: inputs.input, expected: inputs.expected, context: inputs.context },
    "ContextPrecision"
  );

  const response = await client.chat.completions.create({
    ...chatArgs,
    messages: [
      {
        role: "user",
        content: mustache.render(CONTEXT_PRECISION_PROMPT, {
          question: input,
          answer: expected,
          context,
        }),
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "verify",
          description: "Verify if context was useful in arriving at the answer",
          parameters: zodToJsonSchema(contextPrecisionSchema),
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "verify" } },
  });

  const precision = contextPrecisionSchema.parse(mustParseArgs(response));

  return {
    name: "ContextPrecision",
    score: precision.verdict,
    metadata: {
      precision,
    },
  };
};

function parseArgs(args: ScorerArgs<string, RagasArgs>): {
  output: string;
  input?: string;
  expected?: string;
  context?: string;
  chatArgs: Omit<
    OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    "messages"
  >;
  client: OpenAI;
} {
  const {
    input,
    output,
    expected,
    context,
    model,
    temperature,
    maxTokens,
    ...clientArgs
  } = args;
  const chatArgs: Omit<
    OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
    "messages"
  > = {
    model: args.model ?? DEFAULT_RAGAS_MODEL,
    temperature: args.temperature ?? 0,
  };
  if (args.maxTokens) {
    chatArgs.max_tokens = args.maxTokens;
  }

  return {
    input,
    output,
    expected,
    context: flatenContext(context),
    chatArgs,
    client: buildOpenAIClient(clientArgs),
  };
}

function flatenContext(context?: string | string[]): string | undefined {
  return context === undefined
    ? context
    : Array.isArray(context)
    ? context.join("\n")
    : context;
}

function checkRequired<T>(
  args: Record<string, T | undefined>,
  name: string
): Record<string, T> {
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined) {
      throw new Error(`${name} requires ${key} value`);
    }
  }

  return args as Record<string, T>;
}

function mustParseArgs(
  resp: OpenAI.Chat.Completions.ChatCompletion
): Record<string, unknown> {
  const args = resp.choices[0]?.message.tool_calls?.[0]?.function.arguments;
  if (!args) {
    throw new Error("No tool call returned");
  }

  return JSON.parse(args);
}
