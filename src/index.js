import express from 'express'

const app = express();

const port = 3030;

app.get('/', (req, res) => {
    res.status(200).json({
        message: `app running at port ${port}`
    })
})

app.listen(port, () => {
    console.log(`app running at port ${port}`)
})