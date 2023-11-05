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
    // console.log("Text passed to createEmbeddings:", text);
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
    client = await MongoClient.connect(MONGO_URI);
    const db = client.db('fileCabinet');
    const collection = db.collection('pdfs');

    const promises = req.files.map(async (file) => {
        const text = await pdf(file.buffer);
        // console.log("Extracted text from PDF:", text.text);  // Log the extracted text
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

const DATABASE_NAME = 'fileCabinet';

app.post('/chat', async (req, res) => {
    let client;
    try {
        const userMessage = req.body.message;
        if (!req.session.chatHistory) {
            req.session.chatHistory = [];
        }

        const embedding = await createEmbeddings(userMessage);
        client = await MongoClient.connect(MONGO_URI);
        const db = client.db(DATABASE_NAME);
        const pdfsCollection = db.collection('pdfs');
        const chatHistoryCollection = db.collection('chatSessions');

        console.log(`Fetching chat history for session: ${req.session.id}`);
        let previousMessages = await chatHistoryCollection.find({ sessionId: req.session.id })
            .sort({ timestamp: -1 })
            .toArray();

        previousMessages.forEach(msg => {
            console.log(`Fetched Prev Msg - ID: ${msg._id}, Msg: ${msg.message}, Response: ${msg.response}`);
        });

        const documents = await pdfsCollection.find({}).toArray();
        const chatSessions = await chatHistoryCollection.find({}).toArray();

        let combinedContext = '';
        let contextAndScores = []; // To store contexts and their similarity scores

        documents.forEach((doc) => {
            const similarity = cosineSimilarity(embedding, doc.embedding);
            if (similarity > 0.95) {
                combinedContext += doc.full_text + ' ';
                contextAndScores.push({ text: doc.full_text, score: similarity });
            }
        });
        chatSessions.forEach((session) => {
            if (session.embedding) { // Ensure there is an embedding to compare with
                const similarity = cosineSimilarity(embedding, session.embedding);
                console.log(`Session ID: ${session._id}, Similarity Score: ${similarity.toFixed(2)}`); // Log the ObjectID and similarity score
                if (similarity > 0.8) { // Use your similarity threshold
                    combinedContext += session.message + ' ';
                    contextAndScores.push({ text: session.message, score: similarity });
                }
            }
        });
        

        console.log("Similar contexts and scores:", contextAndScores);

        let gptResponse = combinedContext.length > 0
            ? await askGPT(userMessage, combinedContext, previousMessages)
            : `No matches found for '${userMessage}'. Please refine your query.`;

        const chatEntry = {
            sessionId: req.session.id,
            message: userMessage,
            response: gptResponse,
            timestamp: new Date(),
            embedding: embedding
        };
        await chatHistoryCollection.insertOne(chatEntry);

        req.session.chatHistory.push({ role: 'user', message: userMessage }, { role: 'assistant', message: gptResponse });


        res.json({ response: gptResponse, chatHistory: req.session.chatHistory });

    } catch (error) {
        console.error("Error during /chat route processing:", error);
        res.status(500).json({ error: 'An error occurred while processing your chat message.' });
    } finally {
        if (client) {
            console.log("Closing MongoDB client.");
            await client.close();
        }
    }
});

async function askGPT(userMessage, context, sessionChatHistory) {
    console.log("askGPT function called with message: ", userMessage);
    if (context) {
        console.log("Context provided for GPT: ", context.substring(0, 50) + "...");
    }

    sessionChatHistory.unshift({ role: "system", content: `Here's a matched document excerpt: ${context}` });

    const formattedSessionChatHistory = sessionChatHistory.map(chatMessage => ({
        role: chatMessage.role,
        content: chatMessage.message || chatMessage.content // Ensure compatibility with both 'message' and 'content' keys
    }));

    console.log("Formatted chat history for GPT: ", JSON.stringify(formattedSessionChatHistory, null, 2));

    try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: "gpt-3.5-turbo",
                messages: formattedSessionChatHistory,
            }),
        });

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`API responded with status ${response.status}: ${errorBody}`);
            throw new Error(`API responded with status ${response.status}`);
        }

        const data = await response.json();

        if (!data.choices || !Array.isArray(data.choices) || data.choices.length === 0 || !data.choices[0].message) {
            console.error("Unexpected response structure from OpenAI:", data);
            throw new Error("Unexpected response structure from OpenAI");
        }

        const gptResponseContent = data.choices[0].message.content;
        console.log("GPT response: ", gptResponseContent);
        return gptResponseContent;
    } catch (error) {
        console.error("Error in askGPT function:", error);
        throw error;
    }
}

app.listen(3000, () => {
    console.log('Server started on http://localhost:3000');
});

