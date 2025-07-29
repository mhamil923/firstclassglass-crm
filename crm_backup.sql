-- MySQL dump 10.13  Distrib 9.3.0, for macos15.2 (arm64)
--
-- Host: 127.0.0.1    Database: firstclassglass_crm
-- ------------------------------------------------------
-- Server version	9.3.0

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `customers`
--

DROP TABLE IF EXISTS `customers`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `customers` (
  `id` int NOT NULL AUTO_INCREMENT,
  `name` varchar(200) NOT NULL,
  `billingAddress` text NOT NULL,
  `createdAt` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `name` (`name`)
) ENGINE=InnoDB AUTO_INCREMENT=6 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `customers`
--

LOCK TABLES `customers` WRITE;
/*!40000 ALTER TABLE `customers` DISABLE KEYS */;
INSERT INTO `customers` VALUES (1,'Clear Vision','1525 Rancho Conejo Blvd. STE #207, Newbury Park, CA 91320','2025-06-27 08:21:02'),(2,'True Source','263 Jenckes Hill Rd. Lincoln, RI 02865','2025-06-27 08:21:02'),(3,'CLM','2655 Erie St. River Grove, IL 60171','2025-06-27 08:21:02'),(4,'KFM247','15947 Frederick Road, Woodbine, MD 21797','2025-06-27 08:38:19'),(5,'1st Time Fixed LLC','334 Kevyn Ln, Bensenville IL 60106','2025-06-27 08:38:19');
/*!40000 ALTER TABLE `customers` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `line_items`
--

DROP TABLE IF EXISTS `line_items`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `line_items` (
  `id` int NOT NULL AUTO_INCREMENT,
  `work_order_id` int NOT NULL,
  `item` varchar(255) NOT NULL,
  `quantity` int NOT NULL,
  PRIMARY KEY (`id`),
  KEY `work_order_id` (`work_order_id`),
  CONSTRAINT `line_items_ibfk_1` FOREIGN KEY (`work_order_id`) REFERENCES `work_orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `line_items`
--

LOCK TABLES `line_items` WRITE;
/*!40000 ALTER TABLE `line_items` DISABLE KEYS */;
/*!40000 ALTER TABLE `line_items` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `id` int NOT NULL AUTO_INCREMENT,
  `username` varchar(100) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `role` enum('dispatcher','tech') NOT NULL DEFAULT 'tech',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `username` (`username`)
) ENGINE=InnoDB AUTO_INCREMENT=5 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `users`
--

LOCK TABLES `users` WRITE;
/*!40000 ALTER TABLE `users` DISABLE KEYS */;
INSERT INTO `users` VALUES (3,'Mark','$2b$10$Zxb9V/5pKIBzVGaepvNXs.aXTV295gMuAq3xP47TDr4XfKb2wXP3K','dispatcher','2025-06-25 12:19:28'),(4,'Jeff','$2b$10$uF.94Ax16inw2v2rw2797evzIw91stNnjSZhlxSfg.jB6q2jCFrMu','tech','2025-06-26 10:45:26');
/*!40000 ALTER TABLE `users` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `work_order_photos`
--

DROP TABLE IF EXISTS `work_order_photos`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `work_order_photos` (
  `id` int NOT NULL AUTO_INCREMENT,
  `workOrderId` int DEFAULT NULL,
  `photoPath` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `workOrderId` (`workOrderId`),
  CONSTRAINT `work_order_photos_ibfk_1` FOREIGN KEY (`workOrderId`) REFERENCES `work_orders` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `work_order_photos`
--

LOCK TABLES `work_order_photos` WRITE;
/*!40000 ALTER TABLE `work_order_photos` DISABLE KEYS */;
/*!40000 ALTER TABLE `work_order_photos` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `work_orders`
--

DROP TABLE IF EXISTS `work_orders`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `work_orders` (
  `id` int NOT NULL AUTO_INCREMENT,
  `poNumber` varchar(50) DEFAULT NULL,
  `customer` varchar(100) NOT NULL,
  `siteLocation` varchar(255) NOT NULL,
  `billingAddress` varchar(255) NOT NULL,
  `problemDescription` text NOT NULL,
  `status` enum('Needs to be Scheduled','Scheduled','Waiting for Approval','Waiting on Parts','Completed') DEFAULT 'Needs to be Scheduled',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  `scheduledDate` date DEFAULT NULL,
  `pdf_url` text,
  `signature` text,
  `pdfPath` varchar(255) DEFAULT NULL,
  `photoPath` varchar(255) DEFAULT NULL,
  `signaturePath` varchar(255) DEFAULT NULL,
  `pageCount` int DEFAULT NULL,
  `notes` text,
  `assignedTo` int DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `fk_work_orders_assignedTo` (`assignedTo`),
  CONSTRAINT `fk_work_orders_assignedTo` FOREIGN KEY (`assignedTo`) REFERENCES `users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=34 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `work_orders`
--

LOCK TABLES `work_orders` WRITE;
/*!40000 ALTER TABLE `work_orders` DISABLE KEYS */;
INSERT INTO `work_orders` VALUES (1,'PO123','true source','Test Location seeing \r\nthis','true source\r\n123 Billing St\r\n','Broken Glass','Needs to be Scheduled','2025-02-25 18:16:16','2024-03-01',NULL,NULL,'uploads/1750773616860.pdf','uploads/1749758947052.png,uploads/1750774538706.jpg,uploads/1751481977444.png,uploads/1751482687871.png','uploads/signed-1749734435996.pdf',NULL,'[{\"text\":\"Seeing if this works\",\"createdAt\":\"2025-06-24T13:51:59.284Z\"},{\"text\":\"Let’s seee\",\"createdAt\":\"2025-07-02T13:21:12.784Z\"},{\"text\":\"seeing if this works\",\"createdAt\":\"2025-07-02T15:13:02.222Z\"},{\"text\":\"yeyeyey\",\"createdAt\":\"2025-07-02T15:16:23.064Z\"},{\"text\":\"Yeye\",\"createdAt\":\"2025-07-02T18:46:09.611Z\"}]',4),(33,'289','Meto','11709 Wolf Creek Ln, Plainfield IL 630-362-0361','11709 Wolf Creek Ln, Plainfield IL 630-362-0361','Broken Window','Scheduled','2025-06-30 20:16:53','2025-07-02',NULL,NULL,NULL,'',NULL,NULL,NULL,4);
/*!40000 ALTER TABLE `work_orders` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Dumping routines for database 'firstclassglass_crm'
--
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2025-07-08 10:52:13
