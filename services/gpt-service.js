// For colored console logs and event handling
require('colors');
const tools = require('../functions/function-manifest');
const EventEmitter = require('events');
const OpenAI = require('openai');

// Import all functions included in function manifest
// Note: the function name and file name must be the same
const availableFunctions = {};
tools.forEach((tool) => {
  let functionName = tool.function.name;
  availableFunctions[functionName] = require(`../functions/${functionName}`);
});

class GptService extends EventEmitter {
  // Set up the AI assistant with its initial personality and knowledge
  constructor() {
    super();
    this.openai = new OpenAI();
    this.callerNumber = null; // Store the caller's phone number
    this.userContext = [
      // Initial instructions and info for the AI
      { 'role': 'system', 'content': `You are a helpful assistant for Bart's Automotive. 
        Keep your responses brief but friendly. Don't ask more than 1 question at a time. 
        If asked about services not listed below, politely explain we don't offer that service but can refer them to another shop.

        Key Information:
        - Hours: Monday to Friday 9 AM to 5 PM
        - Address: 123 Little Collins Street, Melbourne
        - Services: Car service, brake repairs, transmission work, towing, and general repairs

        IMPORTANT: When a customer agrees to a specific time for their service, you MUST use the bookService function 
        to confirm their booking. Do not just acknowledge their agreement - actually book it using the function.
        The bookService function takes a booking_time parameter in the format 'YYYY-MM-DD HH:mm'.

        You must add a '•' symbol every 5 to 10 words at natural pauses where your response can be split for text to speech.` 
      },
      // Welcome message
      { 'role': 'assistant', 'content': 'Welcome to Bart\'s Automotive. • How can I help you today?' },
    ];
    this.partialResponseIndex = 0;    // Tracks pieces of response for order
  }

  // Store the caller's phone number for booking
  setCallerNumber(number) {
    this.callerNumber = number;
  }

  // Store the call's unique ID
  setCallSid(callSid) {
    this.userContext.push({ 'role': 'system', 'content': `callSid: ${callSid}` });
  }

  // Validate and parse function arguments from GPT
  validateFunctionArgs(args) {
    try {
      return JSON.parse(args);
    } catch (error) {
      console.log('Warning: Double function arguments returned by OpenAI:', args);
      // Seeing an error where sometimes we have two sets of args
      if (args.indexOf('{') != args.lastIndexOf('{')) {
        return JSON.parse(args.substring(args.indexOf(''), args.indexOf('}') + 1));
      }
    }
  }

  // Add new messages to conversation history
  updateUserContext(name, role, text) {
    // Handle function responses vs user messages differently
    if (name !== 'user') {
      this.userContext.push({ 'role': role, 'name': name, 'content': typeof text === 'object' ? JSON.stringify(text) : text });
    } else {
      this.userContext.push({ 'role': role, 'content': text });
    }
  }

  // Main function that handles getting responses from GPT
  async completion(text, interactionCount, role = 'user', name = 'user') {
    // Add user's message to conversation history
    // If text is an object (like a function response), stringify it
    const processedText = typeof text === 'object' ? JSON.stringify(text) : text;
    this.updateUserContext(name, role, processedText);

    // Step 1: Send user transcription to Chat GPT
    const stream = await this.openai.chat.completions.create({
      model: 'gpt-4o-2024-11-20',  // Model that supports function calling
      messages: this.userContext,
      tools: tools,
      stream: true,
    });

    // Track both complete response and chunks for speaking
    let completeResponse = '';
    let partialResponse = '';
    let functionName = '';
    let functionArgs = '';
    let finishReason = '';

    // Helper function to collect function call information from the stream
    function collectToolInformation(deltas) {
      let name = deltas.tool_calls[0]?.function?.name || '';
      if (name != '') {
        functionName = name;
      }
      let args = deltas.tool_calls[0]?.function?.arguments || '';
      if (args != '') {
        // args are streamed as JSON string so we need to concatenate all chunks
        functionArgs += args;
      }
    }

    // Process each piece of GPT's response as it comes
    for await (const chunk of stream) {
      let content = chunk.choices[0]?.delta?.content || '';
      let deltas = chunk.choices[0].delta;
      finishReason = chunk.choices[0].finish_reason;

      // Step 2: check if GPT wanted to call a function
      if (deltas.tool_calls) {
        // Step 3: Collect the tokens containing function data
        collectToolInformation(deltas);
      }

      // If GPT wants to call a function, handle that
      if (finishReason === 'tool_calls') {
        const functionToCall = availableFunctions[functionName];
        const validatedArgs = this.validateFunctionArgs(functionArgs);

        // Add caller number to booking service calls
        if (functionName === 'bookService' && this.callerNumber) {
          validatedArgs.callerNumber = this.callerNumber;
        }

        // Say a pre-configured message from the function manifest
        // before running the function
        const toolData = tools.find(tool => tool.function.name === functionName);
        const say = toolData.function.say;

        this.emit('gptreply', {
          partialResponseIndex: null,
          partialResponse: say
        }, interactionCount);

        // Execute the function and get its response
        let functionResponse = await functionToCall(validatedArgs);

        // Convert function response to string if it's an object
        const processedResponse = typeof functionResponse === 'object' ? 
          JSON.stringify(functionResponse) : functionResponse;

        // Step 4: send the info on the function call and function response to GPT
        this.updateUserContext(functionName, 'function', processedResponse);

        // Have OpenAI generate a new response based on the function result
        await this.completion(processedResponse, interactionCount, 'function', functionName);
      } else {
        // We use completeResponse for userContext
        completeResponse += content;
        // We use partialResponse to provide a chunk for TTS
        partialResponse += content;
        // When we hit a pause marker (•) or the end, send that chunk for speech
        if (content.trim().slice(-1) === '•' || finishReason === 'stop') {
          const gptReply = { 
            partialResponseIndex: this.partialResponseIndex,
            partialResponse
          };

          this.emit('gptreply', gptReply, interactionCount);
          this.partialResponseIndex++;
          partialResponse = '';
        }
      }
    }
    // Add GPT's complete response to conversation history
    this.userContext.push({'role': 'assistant', 'content': completeResponse});
    console.log(`GPT -> user context length: ${this.userContext.length}`.green);
  }
}

module.exports = { GptService };