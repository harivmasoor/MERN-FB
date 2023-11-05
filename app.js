const express = require('express');
const multer = require('multer');
const { MongoClient } = require('mongodb');
const { v4: uuidv4 } = require('uuid');
const pdf = require('pdf-parse');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const session = require('express-session');
const path = require('path');
require('dotenv').config();

const app = express();

const MONGO_URI = process.env.MONGO_URI;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const sessionSecret = process.env.SESSION_SECRET;

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const createEmbeddings = async (text) => {
    console.log("Text passed to createEmbeddings:", text);
    const body = {
        model: "text-embedding-ada-002",
        input: text

    };
     
    // Log the body to ensure it has the 'input' property
    console.log("Sending request with body:", JSON.stringify(body));
    
    const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST', 
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify(body)  
    });
    
  
    if(response.status !== 200) {
      console.error("OpenAI API returned status:", response.status);
      console.error("Response text:", await response.text());
      throw new Error('OpenAI API error');
    }
  
    try {
      const data = await response.json();
  
      // Validate data structure
      if(!data.data || !Array.isArray(data.data) || data.data.length === 0) {
        throw new Error('Invalid data from OpenAI');  
      }
      
      return data.data[0].embedding;
    
    } catch (err) {
      throw new Error('Error parsing OpenAI response');
    }
  
  };

  app.use(bodyParser.json());
  app.use(bodyParser.urlencoded({ extended: true }));
  
  // Add the session middleware here
  app.use(session({
      secret: sessionSecret,
      resave: false,
      saveUninitialized: true
  }));
  
app.use(express.static('public'));

app.post('/', upload.array('pdf', 12), async (req, res) => {
    const client = await MongoClient.connect(MONGO_URI);
    const db = client.db('fileCabinet');
    const collection = db.collection('pdfs');

    const promises = req.files.map(async (file) => {
        const text = await pdf(file.buffer);
        console.log("Extracted text from PDF:", text.text);  // Log the extracted text
        const embedding = await createEmbeddings(text.text);                
        const docId = uuidv4();
        return {
            id: docId,
            embedding: embedding,
            full_text: text.text // Store the entire text
        };
    });

    const documents = await Promise.all(promises);

    collection.insertMany(documents, (err, result) => {
        if (err) {
            res.send("Error uploading PDFs");
        } else {
            res.send("PDFs uploaded and indexed!");
        }
    });
});
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/search', async (req, res) => {
    const query = req.body.query;

    // Input validation
    if (!query) {
        return res.status(400).send('Invalid query');
    }
    console.log("Query from request:", query);
    let embedding;
    try {
        embedding = await createEmbeddings(query);
    } catch (err) {
        console.error('Error generating embeddings:', err);
        return res.status(500).send('Error generating embeddings');
    }

    const client = await MongoClient.connect(MONGO_URI);
    const db = client.db('fileCabinet');
    const collection = db.collection('pdfs');

    try {
        const results = await collection.aggregate([
            {
              $searchBeta: {
                vector: embedding,
                field: "embedding" 
              }
            },
            {
              $sort: { score: { $meta: "textScore" } }
            },
            {  
              $limit: 10
            }
          ])
        
        res.json(results);    
    } catch (err) {
        console.error('Error executing search:', err);
        res.status(500).send('Error executing search');
    } finally {
        client.close();
    }
});



const cosineSimilarity = (vecA, vecB) => {
    const dotProduct = vecA.reduce((sum, a, index) => sum + a * vecB[index], 0);
    const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
    const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
    return dotProduct / (magnitudeA * magnitudeB);
};

app.post('/chat', async (req, res) => {
    let client; // Declare client outside the try block to use it in the entire function scope
    try {
        const userMessage = req.body.message;

        // Check and initialize chatHistory if not present
        if (!req.session.chatHistory) {
            req.session.chatHistory = [];
        }

        const embedding = await createEmbeddings(userMessage);

        // Connect to the database without re-declaring 'client'
        client = await MongoClient.connect(MONGO_URI);
        const db = client.db('fileCabinet');
        const collection = db.collection('pdfs');

        const documents = await collection.find({}).toArray();
        if (documents.length === 0) {
            return res.status(404).json({ error: 'No documents found in database' });
        }

        let maxSimilarity = -Infinity;
        let mostSimilarDocument = null;

        for (const doc of documents) {
            if (!doc.embedding || !Array.isArray(doc.embedding) || doc.embedding.length === 0) {
                console.warn('Skipping a document with invalid embedding:', doc.id);
                continue; // Skip this document and go to the next one
            }
            const similarity = cosineSimilarity(embedding, doc.embedding);
            if (similarity > maxSimilarity) {
                maxSimilarity = similarity;
                mostSimilarDocument = doc;
            }
        }
        

        let gptResponse = '';
        if (mostSimilarDocument) {
            const context = mostSimilarDocument.full_text;
            gptResponse = await askGPT(userMessage, context, req.session.chatHistory);
        } else {
            gptResponse = `No matches found for '${userMessage}'. Please refine your query.`;
        }

        req.session.chatHistory.push({
            user: userMessage,
            gpt: gptResponse // Ensure gptResponse is just a string
        });

        res.json({
            response: gptResponse,
            chatHistory: req.session.chatHistory
        });

        await client.close();
    } catch (error) {
        if (client) {
            await client.close();
        }
        console.error("Error during /chat route processing:", error);
        res.status(500).json({ error: 'An error occurred while processing your chat message.' });
    }
});




// Define the askGPT function as an async function
const askGPT = async (userMessage, context, sessionChatHistory) => {
  // Initialize an array for storing the message history to be sent to OpenAI
  const messages = sessionChatHistory || [];
  // Add the user's message to the history
  messages.push({ role: "user", content: userMessage });

  // Add contextual information if available
  if (context) {
    messages.push({ role: "system", content: `Here's a matched document excerpt: ${context}` });
  }

  try {
    // Call the OpenAI API
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, // Make sure to use process.env to access environment variables
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: "gpt-3.5-turbo",
        messages: messages,
      }),
    });

    // Parse the JSON response
    const data = await response.json();

    // Error handling if the expected data is not returned
    if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0 || !data.choices[0].message) {
      throw new Error("Unexpected response from OpenAI");
    }

    // Extract the GPT-3 response
    const gptResponseContent = data.choices[0].message.content;
    
    // After successfully getting a response, append GPT's response to the session chat history
    sessionChatHistory.push({ role: "assistant", content: gptResponseContent });

    // Return the GPT-3 response content
    return gptResponseContent;
  } catch (error) {
    console.error("Error in askGPT function:", error);
    // Rethrow the error to be handled by the caller
    throw error;
  }
};

module.exports = askGPT; // Export the function if this is in a module




app.listen(3000, () => {
    console.log('Server started on http://localhost:3000');
});

